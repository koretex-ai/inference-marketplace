// Single entry point for the node-agent, so the whole thing bundles to one file (esbuild)
// for the one-command installer (P1). Subcommands (exposed as `koretex <cmd>`):
//   pair    → link this machine to a Solana wallet (opens Phantom)
//   status  → show wallet, whether it's serving, and local models
//   stop    → pause serving      start → resume serving
//   models  → add/remove models to serve (interactive, or ls|add|rm) — works after first install
//   (none)  → run the agent (register + pull jobs); used by the OS service (launchd/systemd)
import { startAgent } from "./index.js";
import { runPair } from "./pair.js";
import { status, stop, start } from "./service.js";
import { manageModels } from "./models.js";

switch (process.argv[2]) {
  case "pair": runPair(); break;
  case "status": status(); break;
  case "stop": stop(); break;
  case "start": start(); break;
  case "models": manageModels(process.argv.slice(3)); break;
  default: startAgent();
}
