#!/usr/bin/env bash
# Brings the VPS up to date with GitHub: pull, install, build the UI, restart the API.
# GitHub Actions runs this over SSH on every push to main; you can also run it by hand.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/.."

git pull --ff-only
(cd backend && bun install --frozen-lockfile --production)
(cd frontend && bun install --frozen-lockfile && VITE_API_URL=/api bun --bun run build) # --bun: no Node.js needed
sudo systemctl restart inj-cctp-redeemer

# Fail the deploy (and the GitHub Action) if the API doesn't come back up.
port=$(sed -n 's/^PORT=//p' backend/.env 2>/dev/null || true)
for _ in $(seq 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${port:-3000}/health"; then
    echo "Deployed $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "API did not come back up, see: journalctl -u inj-cctp-redeemer -n 50" >&2
exit 1
