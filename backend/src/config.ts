import { createPublicClient, createWalletClient, fallback, http, parseUnits, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as c from 'viem/chains'

const env = process.env
const testnet = env.NETWORK === 'testnet'
const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback)

export const network = testnet ? 'testnet' : 'mainnet'
export const port = num(env.PORT, 3000)
export const host = env.HOST || '0.0.0.0'
export const corsOrigins = (env.CORS_ORIGIN || '*').split(',').map((o) => o.trim())
export const trustProxy = env.TRUST_PROXY === 'true'
export const requestsPerMinute = num(env.RATE_LIMIT_PER_MINUTE, 30)
export const redeemsPerMinute = num(env.REDEEM_LIMIT_PER_MINUTE, 5)
export const minRedeemAmount = parseUnits(env.MIN_REDEEM_USDC || '0', 6)
export const dbPath = env.DB_PATH || 'cctp.sqlite'
export const lookbackHours = num(env.INDEX_LOOKBACK_HOURS, 72)
export const pollMs = num(env.INDEX_POLL_SECONDS, 30) * 1000

export const IRIS_API = testnet ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com'
export const INJECTIVE_DOMAIN = 29
export const SOLANA_DOMAIN = 5
// CCTP V2 contracts share one address on every EVM chain: https://developers.circle.com/cctp/references/contract-addresses
export const TOKEN_MESSENGER: Hex = testnet ? '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' : '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
export const MESSAGE_TRANSMITTER: Hex = testnet ? '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' : '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'

// CCTP V2 EVM source chains: [domain, name, mainnet, testnet]. https://developers.circle.com/cctp/concepts/supported-chains-and-domains
const evmChains: [number, string, Chain, Chain?][] = [
  [0, 'Ethereum', c.mainnet, c.sepolia],
  [1, 'Avalanche', c.avalanche, c.avalancheFuji],
  [2, 'OP Mainnet', c.optimism, c.optimismSepolia],
  [3, 'Arbitrum', c.arbitrum, c.arbitrumSepolia],
  [6, 'Base', c.base, c.baseSepolia],
  [7, 'Polygon', c.polygon, c.polygonAmoy],
  [10, 'Unichain', c.unichain, c.unichainSepolia],
  [11, 'Linea', c.linea, c.lineaSepolia],
  [12, 'Codex', c.codex, c.codexTestnet],
  [13, 'Sonic', c.sonic],
  [14, 'World Chain', c.worldchain, c.worldchainSepolia],
  [15, 'Monad', c.monad, c.monadTestnet],
  [16, 'Sei', c.sei, c.seiTestnet],
  [18, 'XDC', c.xdc, c.xdcTestnet],
  [19, 'HyperEVM', c.hyperEvm, c.hyperliquidEvmTestnet],
  [21, 'Ink', c.ink, c.inkSepolia],
  [22, 'Plume', c.plumeMainnet, c.plumeSepolia],
  [26, 'Arc', c.arc, c.arcTestnet],
  [30, 'Morph', c.morph],
  [32, 'Cronos', c.cronos, c.cronosTestnet],
  [33, 'Plasma', c.plasma, c.plasmaTestnet],
  [37, 'X Layer', c.xLayer, c.xLayerTestnet],
]
// Sources we can't scan, but whose transfers can still be redeemed by tx hash (+ domain).
const otherDomains: Record<number, string> = { 5: 'Solana', 8: 'Sui', 9: 'Aptos', 25: 'Starknet', 27: 'Stellar', 28: 'EDGE', 31: 'Pharos' }

// RPC_<NAME> overrides the public RPC, e.g. RPC_ETHEREUM or RPC_OP_MAINNET. Comma-separate several URLs for fallback.
const rpcEnv = (name: string) => `RPC_${name.toUpperCase().replace(/\W+/g, '_')}`
function transport(rpcEnv: string) {
  const urls = env[rpcEnv]?.split(',').map((u) => u.trim()).filter(Boolean) ?? []
  const transports = (urls.length ? urls : [undefined]).map((url) => http(url, { timeout: 10_000, retryCount: 1 }))
  return transports.length > 1 ? fallback(transports) : transports[0]!
}

export const sources = evmChains.flatMap(([domain, name, mainnet, testChain]) => {
  const chain = testnet ? testChain : mainnet
  if (!chain) return []
  const client = createPublicClient({ chain, transport: transport(rpcEnv(name)) })
  return [{ domain, name: testnet ? chain.name : name, rpcEnv: rpcEnv(name), chain, client }]
})
export type Source = (typeof sources)[number]

export const injectiveChain = testnet ? c.injectiveTestnet : c.injective
const injectiveTransport = transport(rpcEnv('Injective'))
export const injective = createPublicClient({ chain: injectiveChain, transport: injectiveTransport })
export const relayer = env.RELAYER_PRIVATE_KEY
  ? createWalletClient({ account: privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex), chain: injectiveChain, transport: injectiveTransport })
  : undefined

export const domainName = (domain: number) => sources.find((s) => s.domain === domain)?.name ?? otherDomains[domain]

export function txUrl(domain: number, hash: string) {
  if (domain === INJECTIVE_DOMAIN) return `${injectiveChain.blockExplorers.default.url}/tx/${hash}`
  if (domain === SOLANA_DOMAIN) return `https://solscan.io/tx/${hash}${testnet ? '?cluster=devnet' : ''}`
  const explorer = sources.find((s) => s.domain === domain)?.chain.blockExplorers?.default.url
  return explorer && `${explorer}/tx/${hash}`
}
