# InfraLoom

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22](https://img.shields.io/badge/node-22-339933.svg)

**Self-hosted monitoring for IT infrastructure.** One dashboard for uptime, network devices, UPS units, DNS,
hypervisors, patch status and licence expiry — with alerts to your phone or chat, and public status pages you can
put on a NOC screen.

InfraLoom runs on a single Linux server, stores everything in an encrypted SQLite database, and needs no
cloud account.

## What it does

InfraLoom **monitors** your infrastructure. It does not provision VMs, run configuration management, or manage
container clusters. The few things it can *change* are deliberately limited and role-restricted: power actions on
hypervisor guests, applying OS updates (Patch Management), Wake-on-LAN, and an in-app SSH terminal.

### Monitoring and alerting

| Module | What you get |
|---|---|
| **Uptime Monitor** | HTTP(S), TCP, ICMP ping, DNS, keyword, JSON query, Docker and push-heartbeat monitors; SSL certificate expiry tracking |
| **Routers / Switches / Access Points** | Ping-backed status; optional SNMP (v1, v2c, v3) for interface statistics. **FortiGate** integration discovers FortiSwitches and FortiAPs through the REST API and shows the online/offline state the FortiGate itself reports |
| **UPS** | SNMP (v1, v2c, v3) via the standard UPS-MIB, with an APC PowerNet fallback: battery charge and runtime, load, input/output voltage, history charts, and alerts for power loss, low battery, power restored and unreachable UPS |
| **DNS / DNS Analytics** | Health of local DNS servers (Technitium, Pi-hole, AdGuard Home), SPF/DKIM/DMARC/MX domain checks, Cloudflare zone integration, Technitium query statistics |
| **Net Speed** | Scheduled internet speed tests (Cloudflare, Ookla CLI, LibreSpeed CLI) with history and retention |
| **MyIP** | Public IP lookup from several sources, IP query, DNS resolver check (UDP and DoH) |
| **Hypervisors** | Proxmox VE, Hyper-V and VMware ESXi (7.0+) in one view: node and guest drill-down, usage history, connection health alerts, power actions, SSH web terminal |
| **Network Scanner** | `arp-scan` device inventory, on-demand `nmap` deep scan, Wake-on-LAN, new/offline device alerts |
| **Patch Management** | See pending OS updates per guest (dry run), approve, apply with live output. Debian/Ubuntu (apt), RHEL/Fedora (dnf/yum), Alpine (apk) and Windows Update, across Proxmox VMs and LXC and Hyper-V VMs |

### Inventory

- **Licences** — vendor, type, seats, expiry, stored credentials (revealing a password is audited). Each licence has a
  renewal period that decides how early it warns: **monthly → 5 days** before expiry, **yearly → 35 days**
  (30 days if no period is set).
- **Entra ID Apps** — app registration secret expiry tracking, CSV export.

### Notifications

In-app bell with live toasts, plus Telegram, Slack, Discord, ntfy, Pushover and e-mail. Every event type
(monitor down/up, SSL/licence/Entra expiry, new or offline network device, hypervisor unreachable, UPS on battery,
low battery, power restored, UPS offline/online) can be switched per channel, with quiet hours.

### Status pages

Public, no login required:

- `/status` — status page listing all enabled uptime monitors (label, type, state, latency, SSL expiry; not the monitored address)
- `/status/dashboard` — NOC dashboard for a wall display: summary counters, uptime monitors, network devices, DNS, UPS (a red banner appears when a UPS runs on battery); refreshes every 30 seconds
- `/status/hypervisors` — hypervisor overview

These pages are unauthenticated. The dashboard lists device names and states, including the IP address of routers,
switches and access points; the UPS section shows name, state, battery and load only (no address, no SNMP details).
The two `/status/...` pages can be switched off under **Settings → Public TV / status pages**; `/status` has no
switch, so restrict it in your reverse proxy if it should not be public.

### Platform

- **Encrypted database** (SQLCipher); the key lives only in `.env`
- **Authentication** — httpOnly session cookie, account lockout after repeated failures, revocable sessions,
  optional two-factor authentication (TOTP), API keys
- **Roles** — `superadmin`, `admin`, `operator`, `viewer` (see [Roles](#roles))
- **Dashboard** — drag-and-reorder widgets, per user
- **Audit log** — filterable, CSV export
- **Backup** — scheduled or on-demand ZIP (database + encrypted copy of `.env`), with retention
- **In-app updates** — check GitHub, update and restart from the UI

## Requirements

- A Debian/Ubuntu-based Linux server (the installer uses `apt`), run as root
- Internet access for the installer (Node.js 22 via nvm, `nmap`, `arp-scan`, build tools)
- Network reachability from the server to whatever you want to monitor

## Installation

```bash
git clone https://github.com/krajcara/InfraLoom.git
cd InfraLoom
sudo bash install.sh
```

The installer:

1. installs system packages (`curl`, `git`, build tools, `nmap`, `arp-scan`, `sqlite3`, ...) and Node.js 22 LTS;
2. clones the repository to `/opt/infraloom` and installs dependencies;
3. generates `.env` with fresh secrets, builds the frontend and creates the encrypted database;
4. creates a **superadmin** account;
5. installs and starts the `infraloom` systemd service (starts on boot);
6. prints the login URL and the generated superadmin credentials — **save them**.

Two-factor authentication is optional; enable it later under **Profile**.

### HTTPS

InfraLoom speaks plain HTTP on port 3000 (`APP_PORT`). Put it behind a reverse proxy that terminates TLS
(Nginx, Nginx Proxy Manager, Caddy, ...) and then set `COOKIE_SECURE=true` in `.env` so the session cookie is only
sent over HTTPS. The SSH web terminal uses WebSockets (`/socket.io`) — enable WebSocket support in the proxy.

## Configuration

All settings are environment variables in `/opt/infraloom/.env` (see [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `APP_PORT` | Port the app listens on (default `3000`) |
| `APP_SECRET` | Signing secret for session tokens (`openssl rand -hex 64`) |
| `DB_PATH` | Location of the SQLCipher database (default `./data/infraloom.db`) |
| `DB_ENCRYPTION_KEY` | Database encryption key. **Losing it means losing the data — back it up** |
| `BACKUP_ENCRYPTION_PASSWORD` | Encrypts the `.env` copy inside backups (see [Backup and restore](#backup-and-restore)) |
| `COOKIE_SECURE` | `true` once served over HTTPS |
| `GITHUB_TOKEN` | Optional; only needed if the repository is private |

Notification channels, SMTP, quiet hours, TV pages and schedules are configured in the UI under **Settings**.

## Updating

```bash
sudo bash /opt/infraloom/update.sh
```

or **Admin → Update** in the app (live progress). The updater compares the installed version with the latest
GitHub **release** (or, if the repository has no releases, with the latest commit on `main`), pulls, runs database
migrations, rebuilds the frontend and restarts the service. Your `.env` and `data/` directory are never touched.

> If you publish releases, bump `version` in `server/package.json` to match the release tag — that is the version the
> updater reads.

## Service management

```bash
sudo systemctl status infraloom
sudo systemctl restart infraloom
sudo journalctl -u infraloom -f
```

## Setting things up

### Roles

| Role | Can do | Cannot do |
|---|---|---|
| **Viewer** | View everything | Create, edit, run or delete anything; user management |
| **Operator** | Viewer + add devices, monitors and UPS units, start network scans and patch runs, renew licences, reveal stored passwords | Delete things, manage connections and credentials, change Settings, user management |
| **Admin** | Operator + delete, manage all connections and credentials, change Settings, manage Operator/Viewer accounts | Run system updates, manage Admin/Superadmin accounts |
| **Superadmin** | Everything | — |

### FortiGate (switches and access points)

On the FortiGate create a **REST API administrator** (System → Administrators) with a read-only profile and, if you
use Trusted Hosts, allow the InfraLoom server's address. Add the FortiGate under **Routers** with brand `fortigate` and
paste the API token. **Sync switches/APs** discovers FortiSwitches and FortiAPs
(`/api/v2/monitor/switch-controller/managed-switch/status`, `/api/v2/monitor/wifi/managed_ap`) and then refreshes
every minute. Their online/offline state is whatever the FortiGate reports — managed switches are usually not
reachable from the InfraLoom server, so they are not pinged. **Sync log** shows the raw reply if a field looks wrong.

### UPS

Enable SNMP on the UPS network card and allow queries from the InfraLoom server. Use a read-only community for
v1/v2c, or create a read-only user for v3 (MD5/SHA/SHA-2 authentication; DES/AES-128/AES-256 privacy). Add it under
**UPS** and press **Test connection**. InfraLoom polls every minute, and alerts when mains power is lost, the battery
runs low, power returns, or the UPS stops answering (after three failed polls). SNMP traps are not used.

The standard UPS-MIB (RFC 1628) and APC PowerNet are understood. If a card is not recognised it shows "No data";
an admin can use **SNMP walk** on the card to see what the device exposes.

### Hypervisors

Add connections from **Hypervisors → New connection**. What each platform needs:

#### Proxmox VE

- An **API token** (Datacenter → Permissions → API Tokens) is all that monitoring, listing and power actions need.
- **VM patch management** needs the **QEMU Guest Agent** running inside the guest (`qemu-guest-agent`; ships with
  `virtio-win` on Windows). No extra credentials — it goes through the API token.
- **LXC patch management** needs a separate **SSH login to the Proxmox host** (Proxmox has no REST API for running
  commands inside containers, only the node-local `pct exec`). Set it under the connection's *Patch Management (LXC)*
  section. This is broad access (effectively root on the host) — leave it blank if you do not patch containers.
- **Clusters with different root passwords per node:** the connection-level SSH credentials are the default; expand a
  node to set a per-node override.
- **API behind a reverse proxy:** SSH does not follow the proxy. Set an explicit **Host SSH address** so `pct exec`
  reaches the real host.

#### Hyper-V

- **Host-level WinRM** is required for monitoring and power actions:
  ```powershell
  winrm quickconfig -Force
  winrm set winrm/config/service/auth '@{Basic="true"}'
  winrm set winrm/config/service '@{AllowUnencrypted="true"}'
  ```
- **Guest patch management** needs a separate connection into each guest OS. In Patch Management click
  **Credentials** next to a guest: WinRM for Windows guests, SSH for Linux guests.
- **Automatic guest IP detection** needs Hyper-V Integration Services. If a guest shows no IP:
  1. On the host: `Enable-VMIntegrationService -VMName "X" -Name "Guest Service Interface"` and
     `-Name "Key-Value Pair Exchange"`.
  2. Do a full `Stop-VM` then `Start-VM` (not `Restart-VM` — VMBus channels are negotiated at cold boot).
  3. Linux guests also need the KVP daemon: `sudo apt install linux-tools-generic linux-cloud-tools-generic`, then
     `sudo systemctl enable --now hv-kvp-daemon`. On a non-standard kernel the matching `linux-tools-<kernel>` package
     may not exist; switching to the distro's standard kernel resolves it.
  4. Otherwise type the guest's IP into the Patch Management credentials form.

#### VMware ESXi

- **Requires ESXi 7.0 or newer** (the REST API used does not exist on 6.x).
- Standard root/administrative credentials; no extra host setup.
- Host-level CPU/RAM utilisation is not exposed by this API, so those fields show "—".
- Patch management for ESXi guests is not implemented.

### Patch Management and the management SSH key

InfraLoom has one SSH key pair of its own (the public half is shown in **Settings → Management SSH key**). In
Patch Management, **Install management key** uses a guest's saved password once to put that key into its
`authorized_keys`, after which InfraLoom logs in with the key. On Debian/Ubuntu, if an earlier run left `dpkg`
half-configured, the next patch run repairs it (`dpkg --configure -a`) before upgrading, and existing
configuration files are kept during upgrades.

## Backup and restore

**Admin → Backup** creates a ZIP containing:

- `infraloom.db` — a consistent snapshot of the live database (safe while the app is running)
- `env.enc` — your `.env`, AES-256-GCM encrypted with `BACKUP_ENCRYPTION_PASSWORD`

The database is already encrypted with `DB_ENCRYPTION_KEY`, but that key lives in `.env`; a plaintext `.env` in the
backup would let anyone with the ZIP open the database. So `.env` is encrypted too, with a **different** password that
never travels inside the backup.

**Store `BACKUP_ENCRYPTION_PASSWORD` somewhere separate from the backups** (a password manager, not this server).
Without it a backup cannot be decrypted, by design.

Backups run on a configurable daily schedule with configurable retention, or on demand.

**To restore:**

1. Decrypt `env.enc` with `BACKUP_ENCRYPTION_PASSWORD` (AES-256-GCM; file layout
   `salt(16) | iv(16) | authTag(16) | ciphertext`) to recover the original `.env`.
2. Place the recovered `.env` and `infraloom.db` (renamed to match your `DB_PATH`) into a fresh or existing install.
3. Restart the service.

## Security notes

- The database is encrypted at rest; `.env` is never committed (see `.env.example`).
- Pre-commit secret scanning (gitleaks) is wired through `.githooks/pre-commit`; run `npm install` once after
  cloning to activate it.
- Security headers (helmet), request rate limiting, and no CORS: the frontend and API are always served from the same
  origin.
- CSV exports neutralise formula-injection payloads (values starting with `=`, `+`, `-` or `@`).
- Credentials with broad reach — the Proxmox host SSH login used for LXC patching, Hyper-V per-guest credentials, and
  the FortiGate API token — should only be configured where you actually need them. Prefer read-only profiles.
- Serve InfraLoom over HTTPS and set `COOKIE_SECURE=true` (see [HTTPS](#https)).

## Upgrading from versions with Automation / Kubernetes

Version 1.0.0 removed the Automation module (OpenTofu VM provisioning, templates, Ansible playbooks), the Kubernetes
module and the Vulnerability Scan module — InfraLoom is a monitoring tool now. `update.sh` is enough:

- the old files disappear with the update (`git reset --hard`);
- on first start the database migration **drops the tables of the removed modules** (deployments, templates,
  playbooks, Kubernetes connections and tokens). Take a backup first if you want to keep that history;
- everything else — users, monitors, licences, hypervisor connections, saved guest credentials — is kept.

Optional clean-up of things the old versions installed on the server:

```bash
sudo rm -f /usr/local/bin/tofu                                   # OpenTofu
sudo pip uninstall -y ansible-core --break-system-packages       # Ansible
sudo rm -rf /opt/infraloom/data/tofu /opt/infraloom/data/ansible # leftover working data
```

Do **not** remove `/opt/infraloom/data/ssh`: it holds the management key that Patch Management may use.

## Development

```bash
git clone https://github.com/krajcara/InfraLoom.git && cd InfraLoom
cp .env.example .env     # set APP_SECRET, DB_ENCRYPTION_KEY and BACKUP_ENCRYPTION_PASSWORD (openssl rand -hex 32)
npm install
npm run migrate          # create the encrypted database
npm run seed             # create the superadmin account (credentials are printed)
npm run dev              # API on :3000 (nodemon) + Vite dev server with proxy
```

| Script | |
|---|---|
| `npm run dev` | API and frontend with live reload |
| `npm run build` | Production frontend build into `client/dist` |
| `npm start` | Start the API (serves `client/dist`) |
| `npm run migrate` / `npm run seed` | Create/upgrade the schema; create the first superadmin |

```
client/            React 18 + Vite single-page app
server/src/
  routes/          REST API (one file per module)
  services/        Schedulers and background workers (monitors, polling, notifications, backup, patching)
  lib/             Protocol clients (SNMP, SSH, WinRM, Proxmox/Hyper-V/ESXi, FortiGate, nmap, ...)
  db/              SQLCipher schema, migrations, seed
install.sh         Installer          update.sh   Updater          infraloom.service   systemd unit
```

Stack: Node.js 22, Express, React 18, Vite, SQLCipher (`better-sqlite3-multiple-ciphers`), Socket.io, node-cron,
net-snmp, ssh2.

## License

MIT — see [LICENSE](LICENSE).

---

Powered by **Krajcara**.
