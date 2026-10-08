export type Transfer = {
  sourceDomain: number
  sourceChain: string
  txHash: string
  txUrl?: string
  nonce?: string
  amount?: string
  sender?: string
  recipient?: string
  status: 'pending' | 'ready' | 'redeemed' | 'restricted'
  note?: string
  redeemTx?: string
  redeemTxUrl?: string
}

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '')

async function call(path: string, init?: RequestInit): Promise<{ transfers: Transfer[] }> {
  const res = await fetch(API_URL + path, init).catch(() => {
    throw new Error('Could not reach the redeem server. Please try again.')
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status}).`)
  return data
}

export const isTxHash = (q: string) => /^0x[0-9a-fA-F]{64}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(q)
export const isAddress = (q: string) => /^0x[0-9a-fA-F]{40}$/.test(q) || /^inj1[02-9ac-hj-np-z]{38}$/i.test(q)

export const getAddressTransfers = (address: string) => call(`/address/${address}`)
export const getTxTransfers = (hash: string) => call(`/tx/${hash}`)
export const redeem = (txHash: string, domain: number) =>
  call('/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, domain }) })
