# Koretex Node

This is the open-source code that runs **on your machine** when you join [Koretex](https://koretex.ai)
as an inference provider. It's **hardware-agnostic** — Apple Silicon Macs (Metal), Linux + NVIDIA
GPUs (CUDA), and CPU-only boxes. (Windows: run it inside WSL2, which exposes your NVIDIA GPU to
Linux.) It's published so you can audit exactly what the one-command installer does before you run
it — nothing here is obfuscated, and this is the same code served by
`curl -fsSL https://dispatcher.koretex.ai/install`.

```
curl -fsSL https://dispatcher.koretex.ai/install | bash
```

📖 **New to this? See [INSTALL.md](INSTALL.md)** for step-by-step setup on macOS, Windows (WSL2),
and Linux — plus troubleshooting (Node/zstd, the `koretex` command, keeping the node running, GPU
checks, custom models).

## What's in here

| Path | What it does |
|------|--------------|
| `deploy/install.sh` | The one-command installer. Detects your hardware (Apple Silicon / NVIDIA / CPU), installs a pinned/checksummed inference engine, pulls a fitting model, installs the agent, links your wallet, enables auto-start (launchd on macOS, systemd on Linux). Safe to re-run. |
| `deploy/preflight.sh` | Eligibility + capability check run before install (detects accelerator and usable memory). |
| `deploy/uninstall-agent.sh` | Removes the agent and its services. |
| `src/node-agent/` | The agent itself. Outbound-only (no inbound ports): detects hardware, dials the dispatcher over WebSocket, registers local models, pulls jobs, and proxies them to the local engine bound to `127.0.0.1`. |
| `src/protocol.ts` | The agent ⇄ dispatcher wire protocol (message types). The single contract shared with the (closed-source) dispatcher. |

## How it works (trust model)

- The inference engine is a **pinned, SHA256-verified** build (per-platform checksum) that Koretex
  runs on its own port (`127.0.0.1:11435`), so your own software is never touched and the engine
  can't be reached except through this agent.
- The agent makes **only outbound** connections. No ports are opened on your machine.
- The agent advertises your hardware (`acceleratorMemGb`, `gpuKind`) so the dispatcher only sends
  models that fit and routes by genuine capability — no hardware is favored. Your earnings go to
  the wallet you link during install; nothing else leaves your machine.

## Build it yourself

```bash
npm install
npm run bundle      # → dist/koretex-agent.cjs  (the single file the installer downloads as /agent.js)
npm run typecheck
```

The bundle this produces is byte-for-byte the agent the dispatcher serves at `/agent.js`.

## Contributing

PRs welcome. This repo is the source of truth for the provider-side code; the Koretex dispatcher
vendors it. Keep `src/protocol.ts` backward-compatible — it's a live wire contract with deployed
nodes. Run `npm run typecheck` before opening a PR.

## License

Apache-2.0. See [LICENSE](LICENSE).
