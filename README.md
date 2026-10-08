# Injective CCTP Redeemer

Finishes Circle CCTP transfers **to Injective** for users: they paste a wallet address or burn tx hash, the backend mints the USDC on Injective with its own relayer wallet and pays the gas.

- `backend/`: Bun + Elysia + viem API. Built to be called by any app.
- `frontend/`: Svelte 5 + shadcn-svelte single page that uses the API.

## How it works

1. A CCTP transfer burns USDC on a source chain, Circle attests it, and someone calls `receiveMessage` on Injective to mint. This service does that last step.
2. **Tx hash lookups** find the source chain automatically (by fetching the receipt from every supported EVM chain), then ask Circle's attestation API for the message, and check on Injective whether it was already minted.
3. **Address lookups** use a small SQLite index: the backend watches `DepositForBurn` events on every EVM source chain and stores the ones headed to Injective (domain 29), keyed by sender and recipient. It works with `0x…` and `inj1…` addresses.
4. **Redeems** are simulated before sending (no gas wasted on reverts), sent one at a time from the relayer key, and deduplicated per message. Expired fast-transfer attestations are re-attested automatically.

## Run it

Needs [Bun](https://bun.sh) 1.3+.

```sh
# API
cd backend
bun install
cp .env.example .env      # set RELAYER_PRIVATE_KEY (an Injective EVM key with some INJ)
bun dev                   # http://localhost:3000

# UI
cd frontend
bun install
bun dev                   # http://localhost:5173, expects the API at http://localhost:3000
```

For production, see [Deploy to a VPS](#deploy-to-a-vps) below. Anywhere else: `bun start` in `backend/`, and `VITE_API_URL=https://your-api bun run build` in `frontend/`, then serve `frontend/dist` as static files. Set `NETWORK=testnet` to run against Injective testnet and the testnet source chains.

All settings are documented in [`backend/.env.example`](backend/.env.example). The defaults use free public RPCs, which are slow and rate limited; set `RPC_<CHAIN>` variables for anything serious.

## Deploy to a VPS

A Cloudflare Tunnel connects the server to Cloudflare from the inside, so your domain points at Cloudflare, never at the server's IP, and no web ports are open. On the server, Caddy (listening on localhost only) serves the UI and proxies `/api/*` to the backend, and systemd keeps everything running. On every push to `main`, [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) SSHes into the VPS and runs [`deploy/deploy.sh`](deploy/deploy.sh): pull, install, build the UI, restart, health check.

You need a VPS running Ubuntu 24.04 (or Debian 12), and a domain on Cloudflare (free plan).

**1. Push the repo to GitHub.** Create an empty repo on github.com, then:

```sh
git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:<you>/inj-cctp-redeemer.git
git push -u origin main
```

Pushing over HTTPS with a personal access token? It needs the `workflow` scope, or GitHub rejects `.github/workflows/deploy.yml`.

**2. Set up the VPS once.** As root:

```sh
apt update && apt install -y git curl unzip ufw gpg sudo debian-keyring debian-archive-keyring apt-transport-https
# Caddy from its own repo (the Ubuntu/Debian package is too old for deploy/Caddyfile)
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

useradd -m -s /bin/bash deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart inj-cctp-redeemer' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy
install -d -o deploy -g deploy /opt/inj-cctp-redeemer
ufw allow OpenSSH && ufw --force enable    # SSH only: web traffic comes in through the tunnel
sudo -iu deploy bash -c 'curl -fsSL https://bun.sh/install | bash'
```

Give the server read access to the repo. This prints a public key: add it in the repo under Settings → Deploy keys, with write access off.

```sh
sudo -iu deploy bash -c 'mkdir -p -m 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C vps && ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null && cat ~/.ssh/id_ed25519.pub'
```

Clone, configure and start:

```sh
sudo -iu deploy git clone git@github.com:<you>/inj-cctp-redeemer.git /opt/inj-cctp-redeemer
cd /opt/inj-cctp-redeemer/backend && cp .env.example .env && chown deploy:deploy .env && chmod 600 .env
nano .env    # set RELAYER_PRIVATE_KEY, HOST=127.0.0.1, TRUST_PROXY=true and your RPC_* URLs

cp /opt/inj-cctp-redeemer/deploy/inj-cctp-redeemer.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable inj-cctp-redeemer
cp /opt/inj-cctp-redeemer/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
sudo -iu deploy /opt/inj-cctp-redeemer/deploy/deploy.sh    # first build + start, ends with "Deployed <commit>"
```

**3. Connect the domain with a Cloudflare Tunnel.** In the Cloudflare dashboard:

1. **Networking → Tunnels → Create a tunnel** (Cloudflared). Name it, pick Debian/Ubuntu, and run the install command it shows on the VPS. The tunnel then shows as *Healthy*.
2. In the tunnel, **Routes → Add route → Published application**: subdomain `redeem`, your domain, service URL `http://127.0.0.1:8080`. Delete any existing DNS record for that name first; Cloudflare creates the tunnel's record itself.

The site is now live at `https://redeem.yourdomain.com`, with the API at `https://redeem.yourdomain.com/api`.

**4. Deploy on every push.** On your computer, make a key that GitHub Actions uses to log in as `deploy`, and install it on the VPS:

```sh
ssh-keygen -t ed25519 -N "" -C github-actions -f gh-deploy
cat gh-deploy.pub | ssh root@<vps-ip> 'install -d -m 700 -o deploy -g deploy /home/deploy/.ssh && cat >> /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys'
ssh-keyscan <vps-ip> > gh-known-hosts
```

Then in the GitHub repo, go to Settings → Secrets and variables → Actions and add:

| Secret | Value |
| - | - |
| `SSH_HOST` | the VPS IP (SSH doesn't go through the tunnel) |
| `SSH_USER` | `deploy` |
| `SSH_KEY` | contents of `gh-deploy` (the private key) |
| `SSH_KNOWN_HOSTS` | contents of `gh-known-hosts` |

From then on, each push to `main` deploys, and you can follow it in the Actions tab. You can also deploy by hand with `sudo -iu deploy /opt/inj-cctp-redeemer/deploy/deploy.sh`.

- **Logs:** `journalctl -u inj-cctp-redeemer -f` (API) and `journalctl -u cloudflared -f` (tunnel). The address index (`backend/cctp.sqlite`) and `.env` are gitignored, so they survive deploys.
- **IP history:** if the domain ever pointed straight at the server with a plain `A` record, DNS-history sites may still list the IP. Moving the server to a new IP (Hetzner: *Primary IPs*) cuts that link.
- **Bots:** leave *Bot Fight Mode* off if other apps call your API from their servers, because it challenges every non-browser client. A WAF rate-limiting rule on `/api/redeem` is the gentler option.

## API

All responses are JSON. Errors look like `{ "error": "message" }`.

| Method | Path | Description |
| - | - | - |
| `GET` | `/address/:address` | Pending (unredeemed) transfers sent from or to a `0x…` / `inj1…` address. |
| `GET` | `/tx/:hash?domain=` | Every transfer to Injective in a burn tx. `domain` (CCTP source domain) is optional for EVM chains and Solana; pass it for other non-EVM sources. |
| `POST` | `/redeem` | Body `{ "txHash": "0x…", "domain"?: 6 }`. Mints all redeemable transfers in that tx. |
| `GET` | `/health` | Network, relayer address and INJ balance, last indexed block per chain. |

Lookups and redeems return `{ "transfers": Transfer[] }`:

```jsonc
{
  "sourceDomain": 6,
  "sourceChain": "Base",
  "txHash": "0x…",
  "txUrl": "https://basescan.org/tx/0x…",
  "nonce": "0x…",               // CCTP message nonce (missing until Circle sees the burn)
  "amount": "125.5",            // USDC
  "sender": "0x…",
  "recipient": "0x…",           // who receives the USDC on Injective
  "status": "ready",            // pending | ready | redeemed | restricted
  "note": "…",                  // human readable detail for pending / restricted / failed redeems
  "redeemTx": "0x…",            // Injective mint tx, when this service submitted it
  "redeemTxUrl": "https://blockscout.injective.network/tx/0x…"
}
```

- `pending`: Circle hasn't attested the burn yet (standard transfers take up to ~20 minutes).
- `ready`: can be redeemed now.
- `redeemed`: already minted on Injective.
- `restricted`: can't be redeemed by this service. The burn named a different `destinationCaller`, or it's below `MIN_REDEEM_USDC`.

`POST /redeem` returns `409` when nothing in the tx is redeemable. Otherwise it returns `200`, and each transfer's `status` and `note` say how its attempt went.

Status codes: `400` invalid input, `404` not found / not a transfer to Injective, `409` nothing to redeem, `429` rate limited, `502`/`503` upstream (Circle, RPC) or relayer issues.

**Rate limits:** per IP, fixed one-minute windows: `RATE_LIMIT_PER_MINUTE` (default 30) for all requests, and a separate `REDEEM_LIMIT_PER_MINUTE` (default 5) for `POST /redeem`. Every response includes `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. Calls to Circle are also paced globally so the server never trips Circle's own limit.

The UI also accepts deep links: `https://your-ui/?q=<address or tx hash>`.

## Notes

- Address search only covers what the indexer has seen: history from `INDEX_LOOKBACK_HOURS` before the first start, then everything going forward. Tx hash lookups work for any transfer, any age.
- Indexed EVM sources: Ethereum, Avalanche, OP, Arbitrum, Base, Polygon, Unichain, Linea, Codex, Sonic, World Chain, Monad, Sei, XDC, HyperEVM, Ink, Plume, Arc, Morph, Cronos, Plasma, X Layer. Solana burns work by tx signature. Other sources (Sui, Aptos, Starknet, Stellar, EDGE, Pharos) can be looked up and redeemed through the API by passing their CCTP `domain`.
- Keep the relayer wallet funded with a small amount of INJ. A standard mint costs about 350k gas (~0.00006 INJ at current prices). `GET /health` shows the balance.
