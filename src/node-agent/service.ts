// Local node control for providers: `koretex status | stop | start`. Wraps the launchd service
// the installer set up, so a provider can pause/resume serving without hand-editing launchctl.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIdentity } from "./identity.js";

const LABEL = "com.koretex.node-agent";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:11434";
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

function sh(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const isRunning = () => sh(`launchctl print gui/${uid()}/${LABEL}`);

export function stop(): void {
  if (!isRunning()) return console.log("Node is already stopped.");
  sh(`launchctl bootout gui/${uid()}/${LABEL}`);
  console.log("⏸  Stopped serving. Run `koretex start` to resume.");
}

export function start(): void {
  if (!existsSync(PLIST)) return console.log("Node isn't installed. Re-run the installer first.");
  if (isRunning()) {
    sh(`launchctl kickstart -k gui/${uid()}/${LABEL}`);
    return console.log("▶️  Restarted — serving again.");
  }
  // Clear any stale registration first — a bare bootstrap of an already-known label fails
  // with "Input/output error". Then load, falling back to kickstart.
  sh(`launchctl bootout gui/${uid()}/${LABEL}`);
  if (sh(`launchctl bootstrap gui/${uid()} "${PLIST}"`) || sh(`launchctl kickstart -k gui/${uid()}/${LABEL}`))
    console.log("▶️  Started — serving again.");
  else console.log("Could not start the node. Re-run the installer.");
}

export async function status(): Promise<void> {
  const id = loadIdentity();
  // A token means we're linked; the address may be absent locally (it lives server-side).
  console.log(`Wallet:  ${id ? id.address || "(linked — see your dashboard)" : "(not linked — run the installer)"}`);
  console.log(`Serving: ${isRunning() ? "yes ✓" : "no (stopped)"}`);
  try {
    const j: any = await (await fetch(`${ENGINE_URL}/v1/models`)).json();
    const models = (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
    console.log(`Models:  ${models.length ? models.join(", ") : "(none — is Ollama running?)"}`);
  } catch {
    console.log("Models:  (engine not reachable — is Ollama running?)");
  }
  console.log("Tip:     `koretex models` to add or remove models you serve.");
}
