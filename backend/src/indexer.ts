import { Database } from 'bun:sqlite'
import { BaseError, parseAbiItem, parseEventLogs, type Hex, type TransactionReceipt } from 'viem'
import { dbPath, INJECTIVE_DOMAIN, lookbackHours, pollMs, sources, TOKEN_MESSENGER, type Source } from './config'

// Watches every EVM source chain for burns headed to Injective, so transfers can be looked up by wallet address.

const DepositForBurn = parseAbiItem(
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
)
type Burn = { transactionHash: Hex; logIndex: number; args: { depositor: Hex; mintRecipient: Hex; destinationDomain: number } }

const db = new Database(dbPath, { create: true })
db.run('PRAGMA journal_mode = WAL')
db.run(`CREATE TABLE IF NOT EXISTS burns (
  domain INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  redeemed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, tx_hash, log_index)
)`)
db.run('CREATE INDEX IF NOT EXISTS burns_tx ON burns (tx_hash)')
db.run('CREATE INDEX IF NOT EXISTS burns_sender ON burns (sender)')
db.run('CREATE INDEX IF NOT EXISTS burns_recipient ON burns (recipient)')
db.run('CREATE TABLE IF NOT EXISTS cursors (domain INTEGER PRIMARY KEY, block INTEGER NOT NULL)')
db.run('CREATE TABLE IF NOT EXISTS redeems (nonce TEXT PRIMARY KEY, tx_hash TEXT NOT NULL)')

const insertBurn = db.query('INSERT OR IGNORE INTO burns (domain, tx_hash, log_index, sender, recipient) VALUES (?, ?, ?, ?, ?)')
const getCursor = db.query<{ block: number }, [number]>('SELECT block FROM cursors WHERE domain = ?')
const setCursor = db.query('INSERT OR REPLACE INTO cursors (domain, block) VALUES (?, ?)')

function saveBurns(domain: number, burns: Burn[]) {
  for (const { transactionHash, logIndex, args } of burns) {
    if (args.destinationDomain !== INJECTIVE_DOMAIN) continue
    insertBurn.run(domain, transactionHash.toLowerCase(), logIndex, args.depositor.toLowerCase(), `0x${args.mintRecipient.slice(26)}`.toLowerCase())
  }
}

export const indexReceipt = (domain: number, receipt: TransactionReceipt) =>
  saveBurns(domain, parseEventLogs({ abi: [DepositForBurn], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === TOKEN_MESSENGER.toLowerCase()))

export const domainOf = (txHash: string) =>
  db.query<{ domain: number }, [string]>('SELECT domain FROM burns WHERE tx_hash = ? LIMIT 1').get(txHash.toLowerCase())?.domain

export const unredeemedTxs = (address: string) =>
  db
    .query<{ domain: number; txHash: string }, [string]>(
      `SELECT domain, tx_hash AS txHash FROM burns WHERE (recipient = ?1 OR sender = ?1) AND redeemed = 0
       GROUP BY domain, tx_hash ORDER BY MAX(rowid) DESC LIMIT 25`,
    )
    .all(address)

export const markRedeemed = (domain: number, txHash: string) =>
  db.query('UPDATE burns SET redeemed = 1 WHERE domain = ? AND tx_hash = ?').run(domain, txHash.toLowerCase())

export const saveRedeem = (nonce: string, txHash: string) => db.query('INSERT OR REPLACE INTO redeems VALUES (?, ?)').run(nonce, txHash)

export const redeemTxOf = (nonce: string) =>
  db.query<{ tx_hash: string }, [string]>('SELECT tx_hash FROM redeems WHERE nonce = ?').get(nonce)?.tx_hash

export const indexedBlocks = () =>
  Object.fromEntries(sources.map((s) => [s.name, getCursor.get(s.domain)?.block ?? null]))

export function startIndexer() {
  for (const source of sources) void scan(source)
}

async function scan({ domain, name, rpcEnv, client }: Source) {
  let cursor = getCursor.get(domain)?.block
  let step = 1000 // public RPCs cap eth_getLogs ranges differently, so the range adapts on errors
  let failures = 0
  let lastWarning = 0
  while (true) {
    try {
      const head = Number(await client.getBlockNumber())
      cursor ??= head - (await lookbackBlocks(client, head))
      if (cursor >= head) {
        await Bun.sleep(pollMs)
        continue
      }
      const to = Math.min(head, cursor + step)
      const logs = await client.getLogs({ address: TOKEN_MESSENGER, event: DepositForBurn, fromBlock: BigInt(cursor + 1), toBlock: BigInt(to), strict: true })
      saveBurns(domain, logs)
      setCursor.run(domain, to)
      cursor = to
      failures = 0
      step = Math.min(step * 2, 10_000)
      if (to === head) await Bun.sleep(pollMs)
    } catch (err) {
      step = Math.max(1, Math.floor(step / 2))
      if (++failures >= 5 && Date.now() - lastWarning > 600_000) {
        lastWarning = Date.now()
        console.warn(`[indexer] ${name} keeps failing (set ${rpcEnv} to a better RPC):`, err instanceof BaseError ? err.shortMessage.split('\n')[0] : err)
      }
      await Bun.sleep(Math.min(failures, 30) * 1000)
    }
  }
}

// Converts the lookback window into a block count using the chain's recent block time.
async function lookbackBlocks(client: Source['client'], head: number) {
  if (lookbackHours <= 0) return 0
  const sample = Math.min(head, 1000)
  const [from, to] = await Promise.all([client.getBlock({ blockNumber: BigInt(head - sample) }), client.getBlock({ blockNumber: BigInt(head) })])
  const blockTime = Number(to.timestamp - from.timestamp) / sample || 1
  return Math.min(head, Math.round((lookbackHours * 3600) / blockTime))
}
