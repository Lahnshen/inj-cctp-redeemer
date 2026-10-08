import { Elysia, t } from 'elysia'
import { formatEther } from 'viem'
import { HttpError, lookupAddress, lookupTx, redeem } from './cctp'
import { corsOrigins, host, injective, network, port, redeemsPerMinute, relayer, requestsPerMinute, sources, trustProxy } from './config'
import { indexedBlocks, startIndexer } from './indexer'

// Fixed-window counter per client IP.
function rateLimit(max: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  setInterval(() => {
    const now = Date.now()
    for (const [ip, hit] of hits) if (hit.resetAt <= now) hits.delete(ip)
  }, windowMs).unref()
  return (ip: string) => {
    const now = Date.now()
    let hit = hits.get(ip)
    if (!hit || hit.resetAt <= now) hits.set(ip, (hit = { count: 0, resetAt: now + windowMs }))
    hit.count++
    return { ok: hit.count <= max, limit: max, remaining: Math.max(0, max - hit.count), reset: Math.ceil((hit.resetAt - now) / 1000) }
  }
}
const limits = { requests: rateLimit(requestsPerMinute), redeems: rateLimit(redeemsPerMinute) }

const app = new Elysia()
  .onRequest(({ request, server, set, status }) => {
    const origin = request.headers.get('origin')
    set.headers['access-control-allow-origin'] = corsOrigins.includes('*') ? '*' : origin && corsOrigins.includes(origin) ? origin : corsOrigins[0]!
    set.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
    set.headers['access-control-allow-headers'] = 'content-type'
    set.headers['vary'] = 'origin'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: set.headers as Record<string, string> })

    // Behind a proxy, the last X-Forwarded-For entry is the one the proxy added (earlier ones can be forged by the client).
    const ip = (trustProxy && request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()) || server?.requestIP(request)?.address || 'unknown'
    const isRedeem = request.method === 'POST' && new URL(request.url).pathname === '/redeem'
    const hit = (isRedeem ? limits.redeems : limits.requests)(ip)
    set.headers['ratelimit-limit'] = String(hit.limit)
    set.headers['ratelimit-remaining'] = String(hit.remaining)
    set.headers['ratelimit-reset'] = String(hit.reset)
    if (!hit.ok) {
      set.headers['retry-after'] = String(hit.reset)
      return status(429, { error: `Too many requests, try again in ${hit.reset}s.` })
    }
  })
  .onError(({ code, error, status }) => {
    if (error instanceof HttpError) return status(error.status, { error: error.message })
    if (code === 'VALIDATION' || code === 'PARSE') return status(400, { error: 'Invalid request.' })
    if (code === 'NOT_FOUND') return status(404, { error: 'Not found.' })
    console.error(error)
    return status(500, { error: 'Something went wrong, please try again.' })
  })
  .get('/health', async () => ({
    network,
    relayer: relayer?.account.address ?? null,
    balance: relayer ? await injective.getBalance({ address: relayer.account.address }).then(formatEther, () => null) : null,
    indexedBlocks: indexedBlocks(),
  }))
  .get('/address/:address', ({ params }) => lookupAddress(params.address))
  .get('/tx/:hash', ({ params, query }) => lookupTx(params.hash, query.domain), {
    query: t.Object({ domain: t.Optional(t.Integer({ minimum: 0 })) }),
  })
  .post('/redeem', ({ body }) => redeem(body.txHash, body.domain), {
    body: t.Object({ txHash: t.String(), domain: t.Optional(t.Integer({ minimum: 0 })) }),
  })
  .listen({ port, hostname: host })

startIndexer()
console.log(`CCTP → Injective redeemer (${network}) on http://localhost:${app.server?.port}`)
console.log(`Relayer: ${relayer?.account.address ?? 'disabled (set RELAYER_PRIVATE_KEY)'} · indexing ${sources.length} source chains`)
