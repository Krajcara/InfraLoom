# InfraLoom

Self-hosted IT infrastructure management application. Runs on Ubuntu Linux.

> **Status: Phase 10 complete — Network section done.** Auth, admin tooling,
> inventory, and the full Network domain (Uptime Monitor, Routers/Switches/
> Access Points, DNS, Net Speed, MyIP) are implemented and tested. Next up:
> Infrastructure (Hypervisors, Network Scanner, Patch Management). See
> `PLAN.md` in the project's internal planning docs for the full roadmap.

## Features so far

**Foundation**
- **Encrypted database** — SQLCipher, key never leaves `.env`
- **Authentication** — JWT sessions (httpOnly cookie), account lockout after
  repeated failed attempts, revocable active sessions
- **Two-factor authentication (TOTP)** — optional, enabled per-user from
  Profile (QR code enrollment); not required to log in
- **Role-based users** — `superadmin` / `admin` / `operator` / `viewer`
- **Profile** — change password, manage TOTP, active sessions, API keys
- **Customizable Dashboard** — drag-and-reorder widget cards, per user

**Admin**
- **Settings** — app name, SMTP, notification channels (Telegram, Slack,
  Discord, ntfy, Pushover) with per-event-type rules and quiet hours
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

## Security

- The database is encrypted at rest (SQLCipher, `DB_ENCRYPTION_KEY` in `.env`).
- `.env` is never committed — see `.env.example` for required variables.
- Pre-commit secret scanning (gitleaks) is enabled via `.githooks/pre-commit`.
  Run `npm install` once after cloning to activate the git hook.

## License

MIT — see [LICENSE](LICENSE).

---

Powered by **Krajcara**.
