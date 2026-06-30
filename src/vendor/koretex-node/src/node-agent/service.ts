// Local node control for providers: `koretex status | stop | start`. Wraps the OS service the
// installer set up — launchd on macOS, systemd --user on Linux — so a provider can pause/resume
// serving without hand-editing launchctl/systemctl.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIdentity } from "./identity.js";

const IS_MAC = os.platform() === "darwin";
const LABEL = "com.koretex.node-agent"; // launchd label (macOS)
const UNIT = "koretex-node-agent"; // systemd unit (Linux) — must match install.sh
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
// Linux installs prefer a SYSTEM unit (managed by PID 1); older/no-sudo installs use a --user unit.
const SYS_UNIT_FILE = `/etc/systemd/system/${UNIT}.service`;
const USER_UNIT_FILE = path.join(os.homedir(), ".config", "systemd", "user", `${UNIT}.service`);
const isSystem = existsSync(SYS_UNIT_FILE); // which kind this machine has
const SC = isSystem ? "sudo systemctl" : "systemctl --user"; // start/stop need root for system units
const SC_RO = isSystem ? "systemctl" : "systemctl --user"; // read-only queries don't need sudo
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

const isRunning = () =>
  IS_MAC ? sh(`launchctl print gui/${uid()}/${LABEL}`) : sh(`${SC_RO} is-active --quiet ${UNIT}`);
const isInstalled = () => existsSync(IS_MAC ? PLIST : SYS_UNIT_FILE) || (!IS_MAC && existsSync(USER_UNIT_FILE));

export function stop(): void {
  if (!isRunning()) return console.log("Node is already stopped.");
  if (IS_MAC) sh(`launchctl bootout gui/${uid()}/${LABEL}`);
  else sh(`${SC} stop ${UNIT}`);
  console.log("⏸  Stopped serving. Run `koretex start` to resume.");
}

export function start(): void {
  if (!isInstalled()) return console.log("Node isn't installed. Re-run the installer first.");
  if (!IS_MAC) {
    // systemd: restart is idempotent (starts if stopped, restarts if running). A system unit
    // prompts for sudo here, which is fine from an interactive `koretex start`.
    if (sh(`${SC} restart ${UNIT}`)) console.log("▶️  Started — serving again.");
    else console.log("Could not start the node. Re-run the installer.");
    return;
  }
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
