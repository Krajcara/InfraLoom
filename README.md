# InfraLoom

Self-hosted IT infrastructure management application. Runs on Ubuntu Linux.

> **Status: Phase 13 complete — Infrastructure section done.** Auth, admin
> tooling, inventory, the full Network domain, and the full Infrastructure
> domain (Hypervisors, Network Scanner, Patch Management) are implemented
> and tested. Next up: public status/NOC pages, Backup, final Dashboard
> polish, and public-repo security hardening. See `PLAN.md` in the
> project's internal planning docs for the full roadmap.

## Features so far

**Foundation**
- **Encrypted database** — SQLCipher, key never leaves `.env`
- **Authentication** — JWT sessions (httpOnly cookie), account lockout after
  repeated failed attempts, revocable active sessions
- **Two-factor authentication (TOTP)** — optional, enabled per-user from
  Profile (QR code enrollment); not required to log in
- **Role-based users** — `superadmin` / `admin` / `operator` / `viewer`
- **Profile** — change password, manage TOTP, active sessions, API keys
- **Customizable Dashboard** — drag-and-reorder widget cards, hide/show,
  per user
- **In-app notifications** — bell icon with unread count, live toast popups,
  covers every alert type below (monitors, SSL, licences, network devices,
  hypervisor connectivity) whether or not external channels are configured

**Admin**
- **Settings** — app name, SMTP, notification channels (Telegram, Slack,
  Discord, ntfy, Pushover, Email via Microsoft Graph) with per-event-type
  rules and quiet hours
- **System Update** — checks GitHub, updates and restarts from the UI, with
  a live progress bar and step status
- **Audit Log** — filterable, CSV export

**Inventory**
- **Licences** — tracking, expiry alerts, credential reveal (audited)
- **Entra ID Apps** — app registrations, secret expiry tracking, CSV export

**Network**
- **Uptime Monitor** — HTTP(S), TCP, ICMP, DNS, Keyword, JSON Query, Docker,
  Push heartbeat; SSL certificate expiry tracking; public `/status` page
- **Routers / Switches / Access Points** — ping-backed status, optional SNMP
  (v1/v2c/v3) for interface stats
- **DNS** — local DNS server monitoring (Technitium/Pi-hole/AdGuard/etc.),
  SPF/DKIM/DMARC/MX domain checks, Cloudflare zone integration
- **DNS Analytics** — Technitium query statistics and top-lists
- **Net Speed** — Cloudflare, Ookla, and LibreSpeed providers; configurable
  schedule and retention
- **MyIP** — multi-source public IP lookup, IP query, DNS resolver
  (18 public resolvers, UDP + DoH)

**Infrastructure**
- **Hypervisors** — Proxmox VE, Hyper-V, and VMware ESXi (7.0+) in one view;
  node/guest drill-down, usage bars, power actions, in-app SSH web terminal
  with persistent sessions across navigation. Background health check
  (configurable interval) alerts if a connection goes down, with a
  per-connection snooze for machines you've intentionally powered off.
- **Network Scanner** — `arp-scan`-based device inventory, on-demand `nmap`
  deep scan, Wake-on-LAN, new/offline device notifications
- **Patch Management** — dry-run → approve → apply, with live streaming
  output, grouped by hypervisor → node → OS. Supports Debian/Ubuntu (apt),
  RHEL/Fedora (dnf/yum), Alpine (apk), and Windows (Windows Update, no
  external module needed) — across Proxmox VMs/LXC and Hyper-V VMs. See
  **Hypervisor setup for Patch Management** below for what each platform
  needs configured before patching will work.

## Installation

```bash
git clone https://github.com/krajcara/InfraLoom.git
cd InfraLoom
sudo bash install.sh
```

The installer will:
1. Install Node.js 22 LTS (via nvm), `nmap`, `arp-scan`, and required system packages
2. Install all dependencies and build the frontend
3. Generate the encrypted database and a **superadmin account**
4. Install and start the `infraloom` systemd service (auto-starts on boot)
5. Print the **login URL, server IP, port, and generated superadmin credentials**

On first login, two-factor authentication is optional — enable it later from
**Profile** if you want it.

## Updating

```bash
sudo bash /opt/infraloom/update.sh
```

Or from the app itself: **Admin → Update** (shows a live progress bar).

## Service management

```bash
sudo systemctl status infraloom
sudo systemctl restart infraloom
sudo journalctl -u infraloom -f
```

## Hypervisor setup

Add connections from **Hypervisors → New connection**. What's needed differs
by platform:

### Proxmox VE
- An **API token** (Datacenter → Permissions → API Tokens) is all that's
  needed for monitoring, node/guest listing, and power actions.
- **VM patch management** needs the **QEMU Guest Agent** installed and
  running inside the guest (`qemu-guest-agent` package; comes with
  `virtio-win` on Windows guests). No extra credentials — it goes through
  the same API token.
- **LXC patch management** needs a separate **SSH login to the Proxmox
  host itself** (not a container), since Proxmox has no REST API for
  running commands inside containers — only `pct exec`, which is a
  node-local command. Set this under the connection's **"Patch Management
  (LXC)"** section. This is broader access than the API token (effectively
  root on the host), so leave it blank if you don't need LXC patching.
- **Multi-node clusters with different root passwords per node**: the
  connection-level SSH credentials above are the *default* for any node
  without its own override. Expand a node on the Hypervisors page to set
  a **per-node SSH override** if that node's password differs.
- **If the Proxmox API is reached through a reverse proxy** (Nginx Proxy
  Manager, Cloudflare Tunnel, etc.), SSH won't follow it — that traffic
  isn't proxied the same way HTTPS is. Set an explicit **"Host SSH
  address"** in the connection form so `pct exec` reaches the real host,
  not the proxy.

### Hyper-V
- **Host-level WinRM** is required for monitoring and power actions:
  ```powershell
  winrm quickconfig -Force
  winrm set winrm/config/service/auth '@{Basic="true"}'
  winrm set winrm/config/service '@{AllowUnencrypted="true"}'
  ```
- **Guest patch management** needs a *separate* connection directly into
  each guest OS (the host-level WinRM connection above only manages the
  VM itself — start/stop/etc. — it can't run commands inside it). From
  Patch Management, click **"Credentials"** next to a guest to set:
  - **Windows guests**: WinRM host/username/password (a different WinRM
    connection than the host-level one)
  - **Linux guests**: SSH host/username/password (works out of the box;
    Linux guests need no extra packages for patch management itself)
- **Automatic guest IP detection** requires Hyper-V Integration Services
  reporting it. If a guest shows no IP:
  1. On the host: `Enable-VMIntegrationService -VMName "X" -Name "Guest Service Interface"`
     and `-Name "Key-Value Pair Exchange"`
  2. **Do a full `Stop-VM` then `Start-VM`** (not `Restart-VM` — VMBus
     channels are negotiated at cold boot, a soft restart often isn't enough)
  3. **Linux guests** additionally need the KVP daemon running inside the
     guest: `sudo apt install linux-tools-generic linux-cloud-tools-generic`
     then `sudo systemctl enable --now hv-kvp-daemon`. On a non-standard
     kernel (not the distro's default `-generic` build), the matching
     `linux-tools-<exact-kernel-version>` package may not exist in the
     archive at all — the daemon will fail with "not found for kernel X";
     switching to the distro's standard kernel resolves it.
  4. If automatic detection still isn't available, you can always type
     the guest's IP directly into the Patch Management credentials form
     as a manual fallback — no Integration Services dependency.

### VMware ESXi
- **Requires ESXi 7.0 or newer.** The REST API this integration uses
  (`/api/session`, `/api/vm`, ...) doesn't exist on ESXi 6.x — connecting
  to an older host fails immediately (HTTP 400 with no useful message,
  since the request never reaches a real endpoint). ESXi 6.x is also out
  of VMware's security-patch support, so upgrading is worth doing anyway.
- Standard root/administrative credentials — no extra host-side setup.
- Host-level CPU/RAM utilization isn't exposed by this API the way
  Proxmox's is, so those fields show "—"; VM inventory and power actions
  work normally.
- **Patch management for ESXi guests is not implemented yet** — they
  appear in Patch Management's grouped view with a "not yet supported"
  note rather than a guest list.

## Security

- The database is encrypted at rest (SQLCipher, `DB_ENCRYPTION_KEY` in `.env`).
- `.env` is never committed — see `.env.example` for required variables.
- Pre-commit secret scanning (gitleaks) is enabled via `.githooks/pre-commit`.
  Run `npm install` once after cloning to activate the git hook.
- LXC patch management's host-level SSH credential and Hyper-V's per-guest
  credentials are broader access than the platforms' own API tokens —
  only configure them on connections where you actually need patching.

## License

MIT — see [LICENSE](LICENSE).

---

Powered by **Krajcara**.
