// Single entry point for the node-agent, so the whole thing bundles to one file (esbuild)
// for the one-command installer (P1). Subcommands (exposed as `koretex <cmd>`):
//   pair      → link this machine to a Solana wallet (opens Phantom — interactive)
//   enroll    → headless, self-custody link: generate a local wallet + mint node/customer keys
//   autoserve → pick the highest-demand model that fits this machine and start serving it
//   status    → show wallet, whether it's serving, and local models
//   stop      → pause serving      start → resume serving
//   dashboard → open the web dashboard authenticated as this machine's keypair (no Google login)
//   models    → add/remove models to serve (interactive, or ls|add|rm) — works after first install
//   (none)    → run the agent (register + pull jobs); used by the OS service (launchd/systemd)
import { startAgent } from "./index.js";
import { runPair } from "./pair.js";
import { runEnroll } from "./enroll.js";
import { runBalance } from "./balance.js";
import { runDashboard } from "./dashboard.js";
import { status, stop, start } from "./service.js";
import { manageModels, autoserve, recommend } from "./models.js";

switch (process.argv[2]) {
  case "pair": runPair(); break;
  case "enroll": runEnroll(); break;
  case "balance": runBalance(); break;
  case "dashboard": runDashboard(); break;
  case "autoserve": autoserve(process.argv.slice(3)); break;
  case "recommend": recommend(process.argv.slice(3)); break;
  case "status": status(); break;
  case "stop": stop(); break;
  case "start": start(); break;
  case "models": manageModels(process.argv.slice(3)); break;
  default: startAgent();
}
