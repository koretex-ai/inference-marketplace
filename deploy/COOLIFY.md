# Deploying the dispatcher on Coolify (Hetzner) — koretex.ai

Target domain: **`dispatcher.koretex.ai`** (add a DNS A record → your Hetzner server IP).


Coolify runs the dispatcher as a Docker container and gives it a public domain + automatic
HTTPS via its Traefik proxy. The customer gateway (`/v1/*`) and the node WebSocket (`/node`)
share one domain and one port (8787). WebSockets pass through Traefik with no extra config.

```
customer  ──HTTPS──▶  dispatcher.<domain>  ──▶ Coolify/Traefik ──▶ container:8787
Mac agent ──WSS───▶  dispatcher.<domain>/node ──▶  (same)
```

## 1. The repo Coolify deploys
Coolify deploys **only this repo: `koretex-ai/inference-marketplace`** (branch `master`). The repo
root IS the dispatcher, so Base Directory is `/`.

You do **not** point Coolify at the public `koretex-ai/koretex-node` repo. That repo (the installer
+ node-agent) is **vendored into this one** at `src/vendor/koretex-node` via `git subtree`, and the
Dockerfile copies it in (`COPY src ./src`) and builds `/agent.js` from it. So the provider-side code
ships *inside* the dispatcher image — one repo, one deploy.

Consequence for releases: editing `koretex-node` alone never triggers a deploy. The release flow is
`edit koretex-node → push → git subtree pull into this repo → push` — pushing **this** repo is what
Coolify auto-deploys.

## 2. Create / point the resource in Coolify
1. **Project → New Resource → GitHub App** — use the App installed on the **`koretex-ai`** org (it
   works for this repo whether it's private or public; an unauthenticated "Public Repository" source
   would break if the repo is ever made private again).
2. Pick `koretex-ai/inference-marketplace`, branch `master`.
3. **Build Pack: Dockerfile.** Base Directory `/`. Dockerfile location `Dockerfile`.
4. **Ports Exposes: `8787`**.
5. Enable the auto-deploy webhook (Coolify registers it through the GitHub App).

## 3. Environment variables (Coolify → resource → Environment Variables)
From `deploy/.secrets.env`:
```
PORT=8787
CUSTOMER_KEYS=<your sk-cust-… key>
NODE_TOKEN=<your node token>
DATABASE_URL=<internal postgres connection string>   # durable ledger; unset = in-memory
# Credits / payments (M4 money-in):
SOLANA_RPC_URL=<your Helius/QuickNode URL with API key>   # REQUIRED in prod — public RPC is flaky
ADMIN_FEE_WALLET=<your USDC receiving wallet address>   # REQUIRED for credit purchases
CREDITS_PER_USDC=10000        # optional, default 10000 (1 credit = $0.0001; fine for per-token billing)
SOLANA_COMMITMENT=finalized   # optional, default finalized ('confirmed' = faster)
```
`deploy/.secrets.env` is **gitignored — it never reaches the container.** Coolify injects env from
its Environment Variables panel, so add the above there. Only `SOLANA_RPC_URL` is effectively
required for credits (the rest have working code defaults).

**Postgres (durable ledger):** add a **New Resource → Database → PostgreSQL** in the *same*
Coolify project. Use the **internal** connection string it shows (Docker-network hostname,
e.g. `postgres://postgres:…@<service>:5432/postgres`) — *not* the public `host:port`, and
**don't publicly expose the DB port.** The dispatcher reaches it over Coolify's internal
network. The table (`ledger`) is created automatically on first boot. Data lives in a Docker
volume, so it survives app redeploys.

## 4. Domain + HTTPS
- **Coolify → resource → Domains:** set `https://dispatcher.<yourdomain>`.
- Add a DNS **A record** `dispatcher → <Hetzner server IP>`.
- Coolify provisions Let's Encrypt automatically. (No domain yet? Use the auto-generated
  `*.sslip.io` host Coolify offers — works immediately, still gets HTTPS.)

## 5. Deploy + verify
```bash
curl https://dispatcher.<yourdomain>/healthz          # {"ok":true,"nodes":0,...}
curl https://dispatcher.<yourdomain>/v1/models \
  -H "Authorization: Bearer <sk-cust-…>"              # empty until a node connects
```

## 6. Onboard a provider Mac (one command)
A provider runs this — it checks the Mac, installs Ollama + a model, drops in the agent, links
their Solana wallet (Phantom), and enables auto-start. No repo clone, no dev tools:
```bash
curl -fsSL https://dispatcher.<yourdomain>/install | bash
```
Then verify + try a completion:
```bash
curl https://dispatcher.<yourdomain>/healthz          # nodes: 1
curl -sN https://dispatcher.<yourdomain>/v1/chat/completions \
  -H "Authorization: Bearer <sk-cust-…>" -H "Content-Type: application/json" \
  -d '{"model":"gemma3:12b-it-qat","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```
*(Developer path / first dispatcher Mac, instead of the installer: `./deploy/install-agent.sh`
with `DISPATCHER_URL=wss://dispatcher.<yourdomain>` after a `git clone` + `npm install`.)*

## Notes
- The agent's heartbeat (every 10s) keeps the WSS connection alive through Traefik.
- Redeploy on push: enable Coolify's auto-deploy webhook, or click Deploy.
- The **ledger** is durable (Postgres) when `DATABASE_URL` is set; the **node registry** is
  still in-memory (rebuilds in ~10s as agents reconnect). Don't scale to >1 replica until the
  registry also moves to shared state (Redis) — see M1 in the roadmap.
