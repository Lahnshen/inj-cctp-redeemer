import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  hexToBigInt,
  hexToNumber,
  InsufficientFundsError,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  size,
  slice,
  toHex,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  domainName,
  injective,
  INJECTIVE_DOMAIN,
  IRIS_API,
  MESSAGE_TRANSMITTER,
  minRedeemAmount,
  relayer,
  SOLANA_DOMAIN,
  sources,
  TOKEN_MESSENGER,
  txUrl,
} from './config'
import { domainOf, indexReceipt, markRedeemed, redeemTxOf, saveRedeem, unredeemedTxs } from './indexer'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Transfer = {
  sourceDomain: number
  sourceChain: string
  txHash: string
  txUrl?: string
  nonce?: Hex
  amount?: string
  sender?: string
  recipient?: string
  status: 'pending' | 'ready' | 'redeemed' | 'restricted'
  note?: string
  redeemTx?: string
  redeemTxUrl?: string
}

type Burn = NonNullable<ReturnType<typeof decodeBurn>>
type Found = { transfer: Transfer; burn?: Burn; message?: Hex; attestation?: Hex }
type IrisMessage = { message: Hex | null; eventNonce: Hex; attestation: string | null; status: string; cctpVersion: number }

const transmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function usedNonces(bytes32 nonce) view returns (uint256)',
])
const MessageSent = parseAbiItem('event MessageSent(bytes message)')
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

// ---- Input parsing --------------------------------------------------------------------------------

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

// inj1… and 0x… are two encodings of the same Injective account.
function injToHex(address: string): Hex | undefined {
  const data = [...address.slice(4)].map((ch) => BECH32.indexOf(ch))
  if (!address.startsWith('inj1') || data.length !== 38 || data.includes(-1)) return
  let checksum = 1
  for (const value of [3, 3, 3, 0, 9, 14, 10, ...data]) { // expanded "inj" prefix + data
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    GENERATORS.forEach((g, i) => { if ((top >> i) & 1) checksum ^= g })
  }
  if (checksum !== 1) return
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const value of data.slice(0, -6)) {
    acc = ((acc << 5) | value) & 0xfff
    bits += 5
    if (bits >= 8) bytes.push((acc >> (bits -= 8)) & 0xff)
  }
  return toHex(new Uint8Array(bytes))
}

function parseAddress(input: string): Hex {
  const value = input.trim().toLowerCase()
  const address = /^0x[0-9a-f]{40}$/.test(value) ? (value as Hex) : injToHex(value)
  if (!address) throw new HttpError(400, 'Invalid address. Use a 0x… or inj1… wallet address.')
  return address
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/

function parseTx(input: string, domain?: number) {
  const value = input.trim()
  if (domain !== undefined && !domainName(domain)) throw new HttpError(400, `Unsupported source domain ${domain}.`)
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return { hash: value.toLowerCase() as Hex, domain }
  // With an explicit domain, other chains' hash formats (Stellar, Starknet, Sui…) go to Circle as-is.
  if (domain !== undefined && (/^(0x)?[0-9a-fA-F]{40,64}$/.test(value) || BASE58.test(value))) return { hash: value as Hex, domain }
  if (BASE58.test(value)) return { hash: value as Hex, domain: SOLANA_DOMAIN }
  throw new HttpError(400, 'Invalid transaction hash.')
}

// ---- Circle attestation API (Iris) ----------------------------------------------------------------

let nextIrisSlot = 0

async function iris(path: string, init?: RequestInit) {
  // Circle blocks clients that exceed 40 requests/second for 5 minutes, so pace all calls to ≤ 20/s.
  const wait = nextIrisSlot - Date.now()
  nextIrisSlot = Math.max(nextIrisSlot, Date.now()) + 50
  if (wait > 0) await Bun.sleep(wait)
  const res = await fetch(IRIS_API + path, { ...init, signal: AbortSignal.timeout(10_000) }).catch(() => {
    throw new HttpError(502, 'Could not reach the Circle attestation API.')
  })
  if (res.status === 429) throw new HttpError(503, 'The Circle attestation API is rate limiting us, try again in a few minutes.')
  return res
}

async function fetchMessages(domain: number, txHash: string): Promise<IrisMessage[]> {
  const res = await iris(`/v2/messages/${domain}?transactionHash=${txHash}`)
  if (res.status === 404) return []
  if (!res.ok) throw new HttpError(502, `Circle attestation API error (${res.status}).`)
  const { messages = [] } = (await res.json()) as { messages?: IrisMessage[] }
  return messages.filter((m) => m.cctpVersion === 2) // Injective is on CCTP V2 only
}

const isAttested = (m?: IrisMessage): m is IrisMessage & { message: Hex } =>
  m?.status === 'complete' && !!m.message && m.message !== '0x' && !!m.attestation?.startsWith('0x')

// ---- Messages -------------------------------------------------------------------------------------

// bytes32 → 0x address when it holds an EVM address (Solana & co. keep all 32 bytes)
const word = (b: Hex) => (b.startsWith('0x000000000000000000000000') ? `0x${b.slice(26)}` : b).toLowerCase()

// MessageV2 header (148 bytes) + BurnMessageV2 body: https://developers.circle.com/cctp/references/technical-guide
function decodeBurn(message: Hex) {
  const field = (offset: number, length: number) => slice(message, offset, offset + length)
  if (size(message) < 376 || !same(word(field(76, 32)), TOKEN_MESSENGER)) return // not a token burn
  return {
    destinationDomain: hexToNumber(field(8, 4)),
    destinationCaller: word(field(108, 32)),
    recipient: word(field(184, 32)),
    amount: hexToBigInt(field(216, 32)),
    sender: word(field(248, 32)),
    expirationBlock: hexToBigInt(field(344, 32)),
  }
}

// Finds the supported EVM chain a tx hash belongs to.
async function locate(hash: Hex): Promise<{ domain: number; receipt?: TransactionReceipt }> {
  const indexed = domainOf(hash)
  if (indexed !== undefined) return { domain: indexed }
  try {
    return await Promise.any(
      sources.map(async ({ domain, client }) => {
        const receipt = await Promise.race([client.getTransactionReceipt({ hash }), Bun.sleep(8000).then(() => Promise.reject())])
        indexReceipt(domain, receipt)
        return { domain, receipt }
      }),
    )
  } catch {
    throw new HttpError(404, 'Transaction not found on any supported chain.')
  }
}

// CCTP messages emitted on the source chain, in log order.
async function sentMessages(domain: number, hash: Hex, receipt?: TransactionReceipt): Promise<Hex[]> {
  const client = sources.find((s) => s.domain === domain)?.client
  receipt ??= await client?.getTransactionReceipt({ hash }).catch(() => undefined)
  if (!receipt) return []
  return parseEventLogs({ abi: [MessageSent], logs: receipt.logs })
    .filter((log) => same(log.address, MESSAGE_TRANSMITTER))
    .map((log) => log.args.message)
}

// Resolves every transfer to Injective in a burn transaction, with its current status.
async function inspect(input: string, domainHint?: number): Promise<Found[]> {
  const { hash, domain: hinted } = parseTx(input, domainHint)
  const { domain, receipt } = hinted === undefined ? await locate(hash) : { domain: hinted, receipt: undefined }

  // Circle lists the tx's messages in log order, but leaves out the message bytes until it has
  // attested them. Until then, the MessageSent events on the source chain tell us where funds go.
  const messages = await fetchMessages(domain, hash)
  let onchain: Hex[] | undefined
  const count = messages.length || (onchain = await sentMessages(domain, hash, receipt)).length
  if (!count) throw new HttpError(404, 'No CCTP transfer found for this transaction.')

  const found: Found[] = []
  for (let i = 0; i < count; i++) {
    const m = messages[i]
    const raw = isAttested(m) ? m.message : (onchain ??= await sentMessages(domain, hash, receipt))[i]
    const burn = raw && decodeBurn(raw)
    if (raw && burn?.destinationDomain !== INJECTIVE_DOMAIN) continue
    found.push({
      burn,
      message: isAttested(m) ? m.message : undefined,
      attestation: isAttested(m) ? (m.attestation as Hex) : undefined,
      transfer: {
        sourceDomain: domain,
        sourceChain: domainName(domain) ?? `Domain ${domain}`,
        txHash: hash,
        txUrl: txUrl(domain, hash),
        nonce: m?.eventNonce,
        amount: burn && formatUnits(burn.amount, 6),
        sender: burn?.sender,
        recipient: burn?.recipient,
        status: 'pending',
        note: m ? "Waiting for Circle's attestation, this can take up to ~20 minutes." : 'Waiting for Circle to pick up the burn.',
      },
    })
  }
  if (!found.length) throw new HttpError(404, 'This transaction did not send USDC to Injective.')

  await Promise.all(
    found.map(async ({ transfer: t, burn, attestation }) => {
      if (!attestation || !burn) return
      t.note = undefined
      if (await injective.readContract({ address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'usedNonces', args: [t.nonce!] })) {
        t.status = 'redeemed'
        t.redeemTx = redeemTxOf(t.nonce!)
        t.redeemTxUrl = t.redeemTx && txUrl(INJECTIVE_DOMAIN, t.redeemTx)
      } else if (!/^0x0+$/.test(burn.destinationCaller) && !same(burn.destinationCaller, relayer?.account.address)) {
        t.status = 'restricted'
        t.note = `Only ${burn.destinationCaller} can redeem this transfer.`
      } else if (burn.amount < minRedeemAmount) {
        t.status = 'restricted'
        t.note = `Transfers below ${formatUnits(minRedeemAmount, 6)} USDC are not redeemed by this service.`
      } else {
        t.status = 'ready'
      }
    }),
  )
  if (found.every((f) => f.transfer.status === 'redeemed')) markRedeemed(domain, hash)
  return found
}

// ---- Public API -----------------------------------------------------------------------------------

export async function lookupTx(hash: string, domain?: number) {
  return { transfers: (await inspect(hash, domain)).map((f) => f.transfer) }
}

export async function lookupAddress(input: string) {
  const address = parseAddress(input)
  const results = await Promise.all(unredeemedTxs(address).map((tx) => inspect(tx.txHash, tx.domain).catch(() => [])))
  const transfers = results
    .flat()
    .map((f) => f.transfer)
    .filter((t) => t.status !== 'redeemed' && (same(t.recipient, address) || same(t.sender, address)))
  return { address, transfers }
}

export async function redeem(hash: string, domain?: number) {
  if (!relayer) throw new HttpError(503, 'Redeeming is disabled on this server.')
  const found = await inspect(hash, domain)
  const ready = found.filter((f) => f.transfer.status === 'ready')
  if (!ready.length) {
    const blocked = found.find((f) => f.transfer.status !== 'redeemed')?.transfer
    throw new HttpError(409, blocked ? (blocked.note ?? 'This transfer cannot be redeemed yet.') : 'This transfer has already been redeemed.')
  }
  await Promise.all(
    ready.map(async (f) => {
      const t = f.transfer
      try {
        t.redeemTx = await submit(f)
        t.redeemTxUrl = txUrl(INJECTIVE_DOMAIN, t.redeemTx)
        t.status = 'redeemed'
      } catch (err) {
        const reason = describe(err)
        console.error(`[redeem] ${t.txHash} (${t.nonce}): ${reason}`)
        if (reason === 'Nonce already used') t.status = 'redeemed'
        else t.note = `Redeem failed: ${reason}`
      }
    }),
  )
  if (found.every((f) => f.transfer.status === 'redeemed')) markRedeemed(found[0]!.transfer.sourceDomain, found[0]!.transfer.txHash)
  return { transfers: found.map((f) => f.transfer) }
}

// ---- Relayer --------------------------------------------------------------------------------------

const inflight = new Map<string, Promise<Hex>>()
let queue = Promise.resolve()

// A single relayer key has a single nonce sequence, so transactions go out one at a time.
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.then(() => {}, () => {})
  return run
}

// Concurrent requests for the same message share one attempt.
function submit(f: Found): Promise<Hex> {
  const nonce = f.transfer.nonce!
  let job = inflight.get(nonce)
  if (!job) {
    job = refreshIfExpired(f)
      .then((fresh) => serial(() => send(fresh)))
      .finally(() => inflight.delete(nonce))
    inflight.set(nonce, job)
  }
  return job
}

async function send({ transfer, message, attestation }: Found): Promise<Hex> {
  const args = [message!, attestation!] as const
  const gas = await injective.estimateContractGas({ account: relayer!.account, address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'receiveMessage', args })
  // Padded: USDC on Injective runs a compliance hook on mint that fails when the gas limit is tight.
  const hash = await relayer!.writeContract({ address: MESSAGE_TRANSMITTER, abi: transmitterAbi, functionName: 'receiveMessage', args, gas: (gas * 3n) / 2n })
  const receipt = await injective.waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  saveRedeem(transfer.nonce!, hash)
  console.log(`[redeem] ${transfer.amount} USDC from ${transfer.sourceChain} to ${transfer.recipient}: ${hash}`)
  return hash
}

// Fast-transfer attestations expire ~24h after signing, until Circle re-signs them on request.
async function refreshIfExpired(f: Found): Promise<Found> {
  const expiry = f.burn?.expirationBlock
  if (!expiry || expiry > (await injective.getBlockNumber())) return f
  const { nonce, sourceDomain, txHash } = f.transfer
  const res = await iris(`/v2/reattest/${nonce}`, { method: 'POST' })
  if (!res.ok) throw new Error(`the attestation expired and Circle refused to re-sign it (${res.status})`)
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(5000)
    const m = (await fetchMessages(sourceDomain, txHash)).find((x) => x.eventNonce === nonce)
    const burn = isAttested(m) ? decodeBurn(m.message) : undefined
    if (burn && (!burn.expirationBlock || burn.expirationBlock > (await injective.getBlockNumber())))
      return { ...f, burn, message: m!.message!, attestation: m!.attestation as Hex }
  }
  throw new Error('the attestation expired and Circle has not re-signed it yet, try again in a few minutes')
}

function describe(err: unknown) {
  if (!(err instanceof BaseError)) return err instanceof Error ? err.message : String(err)
  if (err.walk((e) => e instanceof InsufficientFundsError)) return 'the relayer is out of gas funds, please contact the operator'
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
  return (revert instanceof ContractFunctionRevertedError && revert.reason) || err.shortMessage
}
