# Installing a Koretex node

Koretex is **hardware-agnostic**. A node can run on:

- **Apple Silicon Mac** (M1–M4, 16GB+) — uses the Metal GPU via unified memory.
- **Linux + NVIDIA GPU** — uses CUDA; model size is bounded by your **VRAM**.
- **Windows + NVIDIA GPU** — via **WSL2** (a real Linux environment that sees your GPU).
- **CPU-only** — allowed, but slow and low-demand; the network routes traffic away from it.

The one-command installer detects your hardware, installs a pinned + checksum-verified inference
engine on its own port (`127.0.0.1:11435`, separate from any Ollama you already run), pulls a
model that fits, links your wallet, and sets up auto-start (launchd on macOS, systemd on Linux).

```bash
curl -fsSL https://dispatcher.koretex.ai/install | bash
```

> Get your personalised command (with your wallet token) from the **Run a node** tab on the
> dashboard. It looks like:
> `curl -fsSL https://dispatcher.koretex.ai/install | KORETEX_TOKEN=… KORETEX_WALLET=… bash`

---

## macOS (Apple Silicon)

1. Get your install command: dashboard → **Run a node** → **Login with Google** → copy the one-liner.
2. Open **Terminal** (⌘-Space, type "Terminal", Enter).
3. Paste the command, press Enter.

The installer does everything — engine, model, wallet link, auto-start via launchd (survives reboot
and respawns on crash). If it stops asking for **Node.js**, install it once from
<https://nodejs.org> (the macOS LTS `.pkg`), then re-run the command.

Requirements the installer checks: macOS 13+, Apple Silicon, 16GB+ unified memory, enough free disk.

---

## Windows + NVIDIA — via WSL2 (Ubuntu)

You'll run the node inside **WSL2**, a real Ubuntu Linux that uses your NVIDIA GPU. Do everything in
the **Ubuntu** window — *not* PowerShell (PowerShell gives `'DISPATCHER=…' is not recognized`).

**Before you start:** update your **NVIDIA driver** (from [nvidia.com](https://www.nvidia.com/Download/index.aspx)
or GeForce Experience) — that's what exposes the GPU to WSL. No driver is installed *inside* Ubuntu.

1. **Open an admin terminal:** right-click the Start button → **Terminal (Admin)** (or "Windows
   PowerShell (Admin)").

2. **Install Ubuntu (WSL2):**
   ```powershell
   wsl --install
   ```
   Reboot when prompted. After reboot an **Ubuntu** window opens and asks you to create a username
   and password (you'll use the password for `sudo`). If no window opens, launch **Ubuntu** from the
   Start menu.

3. **Turn on systemd** (keeps the node running) — in the **Ubuntu** window:
   ```bash
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```
   Then close Ubuntu, run `wsl --shutdown` in PowerShell, and reopen **Ubuntu** from the Start menu.

4. **Check the GPU is visible** from Ubuntu — you should see your RTX card:
   ```bash
   nvidia-smi
   ```

5. **Install Node 20 + zstd:**
   ```bash
   sudo apt-get update && sudo apt-get install -y zstd
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
   ```

6. **Get your install command:** dashboard → **Run a node** → **Login with Google** → approve the
   signature → copy the one-line command (it carries your wallet token).

7. **Paste it into the Ubuntu window** and press Enter. It installs the engine, pulls a model, links
   your wallet, and starts the node as a systemd **system service** (survives logout).

To also survive a full Windows **reboot**, see [Keeping your node running](#keeping-your-node-running).

---

## Linux (NVIDIA GPU or CPU)

1. Install prerequisites:
   ```bash
   sudo apt-get update && sudo apt-get install -y zstd
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
   ```
   RHEL/Fedora: `sudo dnf install -y zstd nodejs` · Arch: `sudo pacman -S zstd nodejs` — Node must be **20+**.
2. For an NVIDIA GPU, make sure the driver is installed (`nvidia-smi` works).
3. Get your install command from the dashboard (**Run a node** → Login → copy) and run it. It
   installs as a systemd **system service** (survives logout and reboot) — nothing else to do.

---

## Controlling your node

```bash
koretex status                 # wallet link, serving state, loaded models
koretex models                 # interactive picker — what fits your hardware, sorted by earnings
koretex models add <tag>       # pull + serve a model (e.g. qwen3:14b)
koretex models rm <tag>        # stop serving + delete a model
koretex stop | koretex start   # pause / resume
```

If you get `koretex: command not found`, the wrapper isn't on your current shell's PATH yet —
open a **new** terminal, or run `export PATH="$HOME/.local/bin:$PATH"` (see troubleshooting).

---

## Keeping your node running

By default the node runs under your login session and stops when you log out / close the terminal.

| Platform | What to do |
|---|---|
| **macOS** | Nothing — launchd keeps it running and restarts it at login / on crash. |
| **Linux / WSL** | Installs as a **systemd system service** (runs under PID 1 as your user) — already persistent across logout, no linger needed. Control: `sudo systemctl status|start|stop koretex-node-agent`. *(Older `--user` installs instead need `sudo loginctl enable-linger $USER`.)* |
| **Windows / WSL (always-on)** | WSL also shuts the Linux VM down when idle or on reboot. Create a Windows **Task Scheduler** task that runs `wsl -d Ubuntu -u root true` (or `wsl ~`) **At log on** / **At startup** so the distro — and, with linger enabled, your node — comes back automatically. |

Bring it back manually anytime: `koretex start` (or `systemctl --user start koretex-ollama koretex-node-agent`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `koretex: command not found` | Open a new terminal, or run `export PATH="$HOME/.local/bin:$PATH"`. Older installs used `$HOME/.koretex/bin` — check `ls ~/.koretex/bin/koretex` and export that instead. |
| `'DISPATCHER=…' is not recognized` (Windows) | You're in PowerShell. Run the installer inside **WSL2 Ubuntu** instead. |
| Node stops when I close the terminal | Linger isn't enabled: `sudo loginctl enable-linger $USER`. On Windows/WSL also add the Task Scheduler entry above. |
| `systemctl: not found` or an `-ash` / `#` prompt (WSL) | You're in the wrong distro (often `docker-desktop`). Enter Ubuntu: `wsl -d Ubuntu`, and `wsl --set-default Ubuntu` to make it the default. |
| `Failed to connect to bus` from `systemctl --user` (WSL) | The per-user systemd manager isn't running. 1) Check systemd is PID 1: `ps -p 1 -o comm=` should print `systemd`; if not, enable it (`sudo sh -c 'printf "[boot]\nsystemd=true\n" > /etc/wsl.conf'`, then `wsl --shutdown` in PowerShell and reopen). 2) start the user manager: `sudo loginctl enable-linger $USER`, `sudo systemctl start user@$(id -u).service`, `export XDG_RUNTIME_DIR=/run/user/$(id -u)`. Verify with `ls /run/user/$(id -u)/bus`; now `systemctl --user …` works. |
| Stuck at `2/5 Node.js…` | Install Node 20+: `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt-get install -y nodejs`, then re-run. |
| `This engine needs 'zstd'` at `3/5` | `sudo apt-get install -y zstd` (or `dnf`/`pacman`), then re-run. Re-runs are safe. |
| Slow / not using my GPU | While serving, `nvidia-smi` should show an `ollama` process. If a model is too big for your VRAM it falls back to CPU — pick a smaller one with `koretex models`. |
| "I already have the model in my Ollama" | The node serves through its **own managed engine** (port 11435), separate from your personal Ollama (11434). Add registry models with `koretex models add <tag>`. A **custom** model isn't in the registry — copy its files into the managed engine's store (`~/.ollama/models`) and restart, or recreate it there. |
| Install fails downloading `/agent.js` (404) | Transient during a dispatcher redeploy — wait a couple of minutes and re-run. |
| What's happening? | `koretex status` · logs: `journalctl --user -u koretex-node-agent -f` (Linux/WSL) or `/tmp/koretex-agent.log` & `/tmp/koretex-ollama.log`. |

---

## How model-fit works (why some models aren't offered)

The node advertises its **usable accelerator memory** — unified memory on Apple Silicon, **VRAM**
on NVIDIA, capped RAM on CPU — and `koretex models` only offers models that fit it. A model you
serve is matched to demand purely by merit (measured speed + quality), never by what hardware you
run. Big-memory Macs naturally win the largest models; high-throughput NVIDIA cards win
latency-sensitive traffic.
