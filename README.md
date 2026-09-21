# InfraLoom

Self-hosted IT infrastructure management application. Runs on Ubuntu Linux.

> **Status: Phase 1 complete — Auth & Users.** Encrypted database, authentication
> (JWT sessions + optional TOTP two-factor), role-based user management, and
> profile self-service are implemented and tested. Feature modules (Dashboard,
> Network, Infrastructure, ...) are added phase by phase — see `PLAN.md` in the
> project's internal planning docs for the full roadmap.

## Features so far

- **Encrypted database** — SQLCipher, key never leaves `.env`
- **Authentication** — JWT sessions (httpOnly cookie), account lockout after
  repeated failed attempts, revocable active sessions
- **Two-factor authentication (TOTP)** — optional, enabled per-user from
  Profile (QR code enrollment); not required to log in
- **Role-based users** — `superadmin` / `admin` / `operator` / `viewer`, with
  `admin` limited to managing `operator`/`viewer` accounts
- **Users** — create, edit (role, status, full name, email), reset password,
  unlock, delete — with safeguards against removing the last superadmin
- **Profile** — change password, manage TOTP, view/revoke active sessions,
  create/revoke API keys
- **Audit log** — every auth and user-management action is recorded (viewer
  UI arrives in Phase 2)

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
