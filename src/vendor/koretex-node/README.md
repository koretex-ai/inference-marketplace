# Koretex Node

This is the open-source code that runs **on your Mac** when you join [Koretex](https://koretex.ai)
as an inference provider. It's published so you can audit exactly what the one-command installer
does before you run it — nothing here is obfuscated, and this is the same code served by
`curl -fsSL https://dispatcher.koretex.ai/install`.

```
curl -fsSL https://dispatcher.koretex.ai/install | bash
```

## What's in here

| Path | What it does |
|------|--------------|
| `deploy/install.sh` | The one-command installer. Checks the Mac, installs a pinned/checksummed inference engine, pulls a model, installs the agent, links your wallet, enables auto-start. Safe to re-run. |
| `deploy/preflight.sh` | Eligibility check run before install (hardware/OS gate). |
| `deploy/uninstall-agent.sh` | Removes the agent and its launchd services. |
| `src/node-agent/` | The agent itself. Outbound-only (no inbound ports): dials the dispatcher over WebSocket, registers local models, pulls jobs, and proxies them to the local engine bound to `127.0.0.1`. |
| `src/protocol.ts` | The agent ⇄ dispatcher wire protocol (message types). The single contract shared with the (closed-source) dispatcher. |

## How it works (trust model)

- The inference engine is a **pinned, SHA256-verified** build that Koretex runs on its own port
  (`127.0.0.1:11435`), so your own software is never touched and the engine can't be reached
  except through this agent.
- The agent makes **only outbound** connections. No ports are opened on your machine.
- Your earnings go to the wallet you link during install; nothing else leaves your machine.

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
