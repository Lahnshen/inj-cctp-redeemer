<script lang="ts">
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link'
  import SearchIcon from '@lucide/svelte/icons/search'
  import injectiveLogo from './assets/injective.svg'
  import usdcLogo from './assets/usdc.svg'
  import * as Alert from '$lib/components/ui/alert'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Spinner } from '$lib/components/ui/spinner'
  import { getAddressTransfers, getTxTransfers, isAddress, isTxHash, redeem, type Transfer } from '$lib/api'

  const STATUS: Record<Transfer['status'], { label: string; dot: string }> = {
    pending: { label: 'Awaiting attestation', dot: 'bg-amber-500 animate-pulse' },
    ready: { label: 'Ready to redeem', dot: 'bg-emerald-500' },
    redeemed: { label: 'Redeemed', dot: 'bg-muted-foreground/50' },
    restricted: { label: "Can't redeem", dot: 'bg-destructive' },
  }

  const STEPS = [
    ['Paste an address or tx', 'Your 0x… or inj1… wallet, or the burn transaction hash from the source chain.'],
    ['We find the transfer', "We check Circle's attestation and whether the USDC was already minted on Injective."],
    ['Redeem, gas free', 'One click and we submit the mint on Injective. The USDC lands in the recipient wallet.'],
  ]

  let query = $state('')
  let searched = $state('')
  let loading = $state(false)
  let error = $state('')
  let transfers = $state<Transfer[] | null>(null)
  let redeeming = $state<string | null>(null)
  let latest = 0

  async function search(q = query.trim(), quiet = false) {
    if (!isAddress(q) && !isTxHash(q)) {
      error = 'Enter a wallet address (0x… or inj1…) or a burn transaction hash.'
      transfers = null
      return
    }
    const id = ++latest
    if (!quiet) {
      loading = true
      error = ''
    }
    try {
      const result = await (isTxHash(q) ? getTxTransfers(q) : getAddressTransfers(q))
      if (id !== latest) return
      transfers = result.transfers
      searched = q
    } catch (e) {
      if (id === latest && !quiet) {
        error = (e as Error).message
        transfers = null
      }
    } finally {
      if (id === latest) loading = false
    }
  }

  async function redeemTransfer(t: Transfer) {
    latest++ // results of searches started before the redeem are stale
    redeeming = t.txHash
    error = ''
    try {
      const { transfers: updated } = await redeem(t.txHash, t.sourceDomain)
      transfers = (transfers ?? []).map((x) => updated.find((u) => u.nonce && u.nonce === x.nonce) ?? x)
    } catch (e) {
      error = (e as Error).message
      await search(searched, true)
    } finally {
      redeeming = null
    }
  }

  // Other apps can deep link to a transfer: /?q=<address or tx hash>
  const linked = new URLSearchParams(location.search).get('q')
  if (linked) {
    query = linked
    search(linked.trim())
  }

  // Keep pending transfers fresh until Circle's attestation lands.
  $effect(() => {
    if (!transfers?.some((t) => t.status === 'pending')) return
    const timer = setInterval(() => search(searched, true), 30_000)
    return () => clearInterval(timer)
  })

  const short = (value?: string) => (!value ? 'unknown' : value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value)
  const usdc = (amount?: string) =>
    amount ? Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '—'
</script>

<!-- "+" markers where a section's bottom line crosses the two rails -->
{#snippet crosses()}
  <span aria-hidden="true" class="blueprint-cross -bottom-1.5 -left-[5px] max-md:hidden"></span>
  <span aria-hidden="true" class="blueprint-cross -right-[5px] -bottom-1.5 max-md:hidden"></span>
{/snippet}

<div class="relative isolate flex min-h-svh flex-col overflow-hidden">
  <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-full max-w-2xl -translate-x-1/2 border-x max-md:border-x-0"></div>

  <div class="border-b">
    <div class="relative mx-auto h-10 max-w-2xl">{@render crosses()}</div>
  </div>

  <section class="border-b">
    <div class="relative mx-auto max-w-2xl px-5 pt-10 pb-8">
      <div aria-hidden="true" class="blueprint-grid absolute inset-0 -z-10"></div>
      <div class="flex flex-col items-center gap-2 text-center">
        <h1 class="flex items-center gap-2.5 text-xl font-semibold tracking-tighter">
          <span class="flex -space-x-1.5">
            <span class="bg-foreground ring-background flex size-6 items-center justify-center rounded-full ring-2">
              <img src={injectiveLogo} alt="" class="size-3.5 dark:invert" />
            </span>
            <img src={usdcLogo} alt="" class="ring-background size-6 rounded-full ring-2" />
          </span>
          Injective USDC Redeemer
        </h1>
        <p class="text-muted-foreground max-w-full text-balance text-xs">
          Just put your transaction hash or wallet address below to start.
        </p>
      </div>

      <form
        class="bg-card focus-within:border-ring focus-within:ring-ring/50 mx-auto mt-5 flex max-w-lg items-center gap-1 border py-1 px-1 shadow-sm transition-shadow focus-within:ring-3 rounded-full"
        onsubmit={(e) => {
          e.preventDefault()
          search()
        }}
      >
        <SearchIcon class="text-muted-foreground ml-2.5 size-3.5 shrink-0" />
        <Input
          bind:value={query}
          placeholder="0x… / inj1… address or burn tx hash"
          aria-label="Wallet address or burn transaction hash"
          autocomplete="off"
          spellcheck={false}
          class="h-full border-0 bg-transparent font-mono shadow-none placeholder:font-sans focus-visible:ring-0 dark:bg-transparent text-xs placeholder:text-xs normal-case! placeholder:uppercase"
        />
        <Button class="rounded-full text-[0.7rem]" type="submit" size="xs" disabled={loading || !query.trim()}>
          {#if loading}<Spinner />{/if}
          Search
          {#if !loading}<ChevronRightIcon data-icon="inline-end" />{/if}
        </Button>
      </form>
      {@render crosses()}
    </div>
  </section>

  {#if error || transfers}
    <section class="border-b">
      <div class="relative mx-auto flex max-w-2xl flex-col gap-2 px-5 py-5">
        {#if error}
          <Alert.Root variant="destructive" class="py-2.5">
            <Alert.Description class="text-xs">{error}</Alert.Description>
          </Alert.Root>
        {/if}

        {#if transfers?.length === 0}
          <Alert.Root class="py-2.5">
            <Alert.Description class="text-xs">No pending transfers to Injective found for this address.</Alert.Description>
          </Alert.Root>
        {/if}

        {#each transfers ?? [] as t, i (t.nonce ?? `${t.txHash}-${i}`)}
          <Card.Root size="sm">
            <Card.Header>
              <Card.Title class="flex items-center gap-1.5 text-sm! tracking-tight">
                <img src={usdcLogo} alt="" class="size-4" />
                {usdc(t.amount)} USDC
              </Card.Title>
              <Card.Description class="text-xs">
                {t.sourceChain} -> Injective · to <span class="font-mono normal-case!">{short(t.recipient)}</span>
              </Card.Description>
              <Card.Action>
                <Badge variant="outline" class="bg-card gap-1.5 text-[0.6rem]">
                  <span class={['size-1.5 rounded-full', STATUS[t.status].dot]}></span>
                  {STATUS[t.status].label}
                </Badge>
              </Card.Action>
            </Card.Header>
            <Card.Content class="flex flex-col gap-2">
              {#if t.note}
                <p class="text-muted-foreground text-xs">{t.note}</p>
              {/if}
              <div class="flex items-center justify-between gap-3">
                <div class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  {#if t.txUrl}
                    <a class="hover:text-foreground inline-flex items-center gap-1" href={t.txUrl} target="_blank" rel="noreferrer">
                      Burn tx <span class="font-mono normal-case!">{short(t.txHash)}</span>
                      <ExternalLinkIcon class="size-3" />
                    </a>
                  {/if}
                  {#if t.redeemTxUrl}
                    <a class="hover:text-foreground inline-flex items-center gap-1" href={t.redeemTxUrl} target="_blank" rel="noreferrer">
                      Mint tx <span class="font-mono normal-case!">{short(t.redeemTx)}</span>
                      <ExternalLinkIcon class="size-3" />
                    </a>
                  {/if}
                </div>
                {#if t.status === 'ready'}
                  <Button size="xs" onclick={() => redeemTransfer(t)} disabled={redeeming !== null}>
                    {#if redeeming === t.txHash}<Spinner /> Redeeming…{:else}Redeem{/if}
                  </Button>
                {/if}
              </div>
            </Card.Content>
          </Card.Root>
        {/each}
        {@render crosses()}
      </div>
    </section>
  {/if}

  <section class="border-b">
    <div class="relative mx-auto grid max-w-2xl gap-2 px-5 py-5 sm:grid-cols-3">
      {#each STEPS as [title, body], i (title)}
        <div class="bg-card flex flex-col gap-1.5 rounded-lg border p-3.5 shadow-xs">
          <span class="bg-muted text-muted-foreground mb-1 w-fit rounded px-1 py-px text-[10px]">0{i + 1}</span>
          <h2 class="text-xs font-semibold tracking-tight">{title}</h2>
          <p class="text-muted-foreground text-[11px] leading-relaxed">{body}</p>
        </div>
      {/each}
      {@render crosses()}
    </div>
  </section>

  <footer class="text-muted-foreground mx-auto w-full max-w-2xl px-5 py-4 text-center text-[11px]">
    Works for CCTP V2 transfers to Injective from any supported chain.
  </footer>
</div>
