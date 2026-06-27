# Availability & DDoS Resilience

How we keep the marketplace up under load and attack. This is **more than load balancing** —
load balancing is one layer of six.

## The problem: one link carries two planes

`dispatcher.koretex.ai` is currently a single box, a single IP, serving both:

- **Data plane** — customer API traffic (`/v1/*`). The natural DDoS target.
- **Control plane** — the persistent **WSS connections that hold the entire supply fleet online**.

Because they share a host, a flood on the public API doesn't just slow customers down — it
**disconnects every provider node**, which then all reconnect at once (a reconnection storm)
and finish the box off. Decoupling these is the single most important architectural fix.

**Principle:** defense in depth + separate the planes + never let the *cheap* resource
(network bandwidth) exhaust the *expensive* one (inference / GPU time on Macs).

---

## Layer 0 — Edge absorption + origin hiding *(stops volumetric DDoS)*

You cannot absorb a real L3/L4 flood on one Hetzner box, however you balance it. So:

- Put **Cloudflare** (or equivalent) in front of all public hostnames. Its global network
  absorbs volumetric attacks.
- **Hide the origin:** firewall the Hetzner box to accept traffic **only from Cloudflare IP
  ranges** (or use Cloudflare Tunnel / Authenticated Origin Pulls). Attackers can't bypass the
  edge by hitting the raw IP.
- Enable Cloudflare WAF + L7 rate limiting + bot rules.

*Highest-leverage, lowest-effort step. Do this first.*

---

## Layer 1 — Separate the control plane from the data plane *(protect the fleet)*

Split the two planes onto distinct endpoints and ideally distinct infrastructure:

- `api.koretex.ai` — customer gateway. Public, behind Cloudflare + WAF, heavily rate-limited.
- `nodes.koretex.ai` — node control plane (WSS). Locked down: authenticated nodes only,
  ideally **IP-allowlisted to known providers or mTLS**, not advertised for general traffic.

Now a flood on the customer API **physically cannot** knock providers offline. Supply stays up.

---

## Layer 2 — Authenticate + meter early; cap the blast radius

Inference is the expensive resource; cheap-to-reject everything else *before* it reaches a node.

- Validate the API key at the edge; reject unauthenticated/over-quota requests before dispatch.
- **Prepaid USDC balance is itself a DDoS control** — a customer can't flood inference they
  haven't paid for.
- Per-key **concurrency caps** + **spend-rate limits** bound the damage from a single
  compromised key.
- Note: our API is machine-to-machine, so CAPTCHAs don't fit — rate-limit by **API key**, not
  just IP.

---

## Layer 3 — Horizontal scale of a *stateful* WS dispatcher *(remove the SPOF)*

This is the real "load balancing," and it's subtle because the dispatcher holds live WS
connections + the registry. You can't just put N copies behind an LB. You need:

- **Shared state in Redis** — which node is online, on which instance (this is M1).
- A **job-routing fabric** (Redis pub/sub or NATS): a customer request landing on gateway
  instance A must reach a node connected to instance B.
- Then **multiple gateway instances** behind the edge, and **multi-region** gateways with
  nodes connecting to the nearest.

Without shared state + a routing bus, more dispatcher copies don't help — each only knows its
own nodes.

---

## Layer 4 — Graceful degradation *(survive the stress you can't deflect)*

- **Reconnect backoff + jitter** on the node-agent (currently a fixed 3s → reconnection-storm
  risk). Exponential backoff with jitter prevents thundering-herd reconnects after a restart.
- **Load shedding:** under overload, return `429` and shed excess customer requests rather
  than collapsing. Prioritize keeping node connections alive over serving marginal traffic.
- **Bounded queues**, circuit breakers, and heartbeat/keepalive tuning so transient blips
  don't drop healthy nodes.

---

## Layer 5 — See it coming

- Metrics + anomaly detection + alerting on traffic spikes, error rates, node churn.
- Public status page so providers/customers know the state during an incident.

---

## Summary

| Layer | Stops | Effort |
|---|---|---|
| 0. Edge absorption + origin hiding | Volumetric L3/L4 floods | Low — **do first** |
| 1. Control/data-plane separation | Attacks taking down supply | Medium |
| 2. Auth + prepaid + per-key caps | Economic / inference-exhaustion abuse | Medium (ties to M3/M4) |
| 3. Horizontal scale + shared state | Single-instance SPOF | High (needs M1) |
| 4. Graceful degradation | Cascading collapse under stress | Low–medium |
| 5. Observability + status page | Slow incident response | Low |

**The one-liner:** Cloudflare absorbs the volume, plane-separation keeps supply alive,
auth+prepaid makes abuse uneconomical, and *then* horizontal scaling (with shared state)
removes the single point of failure. Load balancing is step 3 of 6 — necessary, not sufficient.

## Near-term quick wins (cheap, high value, do before scaling)
1. Cloudflare in front of `koretex.ai` + lock the Hetzner firewall to Cloudflare IPs.
2. Move node WSS to a separate hostname (`nodes.koretex.ai`).
3. Exponential backoff + jitter in the node-agent reconnect loop.
4. Per-API-key rate + concurrency limits at the gateway.
