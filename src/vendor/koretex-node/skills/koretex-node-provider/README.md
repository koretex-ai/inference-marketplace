# koretex-node-provider — a Hermes Agent skill

Turns the machine running [Hermes Agent](https://hermes-agent.nousresearch.com/) into a
[Koretex](https://dispatcher.koretex.ai) inference node, then repoints the agent's own inference at
Koretex so credits earned while idle pay for the agent's work.

- **Earn:** serves the highest-demand model the machine can host (self-custody wallet, no browser).
- **Spend:** the agent consumes the best model on the network; routing back to itself is free.
- **Resilient:** falls back to the locally-served model (free) if Koretex is unreachable or the
  balance is empty.

This follows the [agentskills.io](https://agentskills.io) open standard, so the same `SKILL.md`
works in Hermes Agent, Claude Code, Cursor, or Codex CLI.

## Layout
- `SKILL.md` — what the agent reads and executes.
- `scripts/koretex-up.sh` — install + self-custody enroll + auto-serve, idempotent; prints a JSON summary.
- `scripts/koretex-status.sh` — serving status, wallet, dashboard link.

## Install
Copy this directory into `~/.hermes/skills/`, or publish it to the Skills Hub. Then ask Hermes to
"join Koretex" / "make this machine earn while idle".

## Under the hood (node-agent commands it drives)
- `koretex enroll` — headless self-custody: generate a local Solana keypair, mint a node token (earn)
  + a customer key (spend) bound to the same wallet.
- `koretex autoserve` — pick & serve the highest-unmet-demand model that fits this machine.
- `koretex recommend --json` — the best network model to consume + the local fallback model.

All of the above are in the public, auditable `koretex-ai/koretex-node` repo.
