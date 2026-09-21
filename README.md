# InfraLoom

Self-hosted IT infrastructure management application. Runs on Ubuntu Linux.

> **Status: Phase 0 — foundations.** This repository currently contains the
> project skeleton only (encrypted database, base schema, installer, systemd
> service). Feature modules are added phase by phase — see `PLAN.md` in the
> project's internal planning docs for the roadmap.

## Installation

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/InfraLoom.git
cd InfraLoom
sudo bash install.sh
```

The installer will:
1. Install Node.js 20 LTS (via nvm), `nmap`, `arp-scan`, and required system packages
2. Install all dependencies and build the frontend
3. Generate the encrypted database and a **superadmin account**
4. Install and start the `infraloom` systemd service (auto-starts on boot)
5. Print the **login URL, server IP, port, and generated superadmin credentials**

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
