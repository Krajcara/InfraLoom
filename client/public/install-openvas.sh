#!/usr/bin/env bash
#
# install-openvas.sh — installs Greenbone Vulnerability Management (GVM /
# OpenVAS) directly on this VM via Debian's native `gvm` package (no
# Docker needed), exposes GMP over TCP so InfraLoom (on a different host)
# can connect, and registers itself with InfraLoom automatically at the end.
#
# Requires Debian 12 (Bookworm) — Debian is one of the distros Greenbone
# packages GVM for natively via apt. Ubuntu doesn't reliably carry the
# `gvm` package in its default repos; if you're on Ubuntu, this script
# will tell you so and stop rather than guess at a workaround.
#
# UNTESTED NOTICE: this could not be run against a real target while
# writing it (a fresh feed sync alone takes 1-3+ hours, more than this
# sandbox can practically run). The steps follow Debian/Greenbone's
# documented `gvm-setup` flow, which is the long-established path (unlike
# an earlier version of this script that guessed at a Docker Compose URL
# and got a 404 — apt packaging has been stable for GVM on Debian for
# years, so this should be firmer ground, but you're still the first real
# test of this exact script). Read through before running.
#
# Usage:
#   sudo bash install-openvas.sh --infraloom-url https://infraloom.example.com --token <token>
#
set -e

INFRALOOM_URL=""
TOKEN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --infraloom-url) INFRALOOM_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ -z "$INFRALOOM_URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: sudo bash install-openvas.sh --infraloom-url <url> --token <token>"
  echo "Get the URL/token from InfraLoom's Vulnerability Scan page ('Generate registration token')."
  exit 1
fi

info()    { echo -e "\033[36m[info]\033[0m $1"; }
success() { echo -e "\033[32m[ok]\033[0m $1"; }
warn()    { echo -e "\033[33m[warn]\033[0m $1"; }

if [ "$EUID" -ne 0 ]; then
  echo "Run this as root: sudo bash install-openvas.sh ..."
  exit 1
fi

GMP_PORT=9390

# ─── OS check ──────────────────────────────────────────────────────────────
if ! grep -qi "debian" /etc/os-release 2>/dev/null; then
  echo "This script targets Debian (the gvm apt package isn't reliably available on Ubuntu)."
  echo "Detected: $(grep PRETTY_NAME /etc/os-release 2>/dev/null || echo 'unknown OS')"
  echo "Easiest fix: recreate this VM from a Debian 12 template instead."
  exit 1
fi

# ─── Install GVM ────────────────────────────────────────────────────────────
info "Installing GVM (gvmd, openvas-scanner, gsad, postgresql, redis) via apt — this pulls in a fair number of packages..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gvm >/dev/null
success "Packages installed."

# ─── First-time setup (feed sync happens here — the slow part) ────────────
info "Running gvm-setup — this creates the database, an initial admin user, and syncs the"
info "vulnerability-test feed. On a fresh install this commonly takes 1-3+ hours; it's"
info "downloading several GB of vulnerability signatures. Please be patient."
info "You can watch progress in another terminal with: tail -f /var/log/gvm/gvm-setup.log"

SETUP_LOG="/tmp/gvm-setup-output.log"
gvm-setup 2>&1 | tee "$SETUP_LOG"

# gvm-setup prints the generated admin password near the end, in a line
# that looks like: "User created with password 'xxxxxxxx'."
# VERIFY this pattern still matches what your version prints — if the
# grep below comes up empty, search $SETUP_LOG yourself for "password".
ADMIN_PASSWORD=$(grep -oE "password '[^']+'" "$SETUP_LOG" | tail -1 | sed -E "s/password '([^']+)'/\1/")

if [ -z "$ADMIN_PASSWORD" ]; then
  warn "Couldn't automatically find the generated admin password in gvm-setup's output."
  warn "Check $SETUP_LOG for a line mentioning the admin password, or reset it with:"
  warn "  runuser -u _gvm -- gvmd --user=admin --new-password=<a-strong-password>"
  read -rp "Enter the admin password to register with InfraLoom: " ADMIN_PASSWORD
fi
success "GVM setup complete."

info "Verifying the install..."
gvm-check-setup || warn "gvm-check-setup reported some issues above — GVM may still work, but worth reviewing."

# ─── Dedicated API user for InfraLoom (rather than using admin directly) ──
info "Creating a dedicated 'infraloom' GMP user..."
GVM_USER="infraloom"
GVM_PASSWORD=$(openssl rand -hex 16)
runuser -u _gvm -- gvmd --create-user="$GVM_USER" --new-password="$GVM_PASSWORD" || {
  warn "Could not create a dedicated user — falling back to the admin account for registration."
  GVM_USER="admin"
  GVM_PASSWORD="$ADMIN_PASSWORD"
}
if [ "$GVM_USER" = "infraloom" ]; then
  runuser -u _gvm -- gvmd --role=Admin --user="$GVM_USER" || warn "Could not grant Admin role to the infraloom user — it may have limited permissions."
fi

# ─── Expose GMP over TCP ────────────────────────────────────────────────────
# By default gvmd only listens on a local unix socket. InfraLoom is on a
# different host, so gvmd needs to also listen on TCP. This adds a
# systemd override for the gvmd service. VERIFY this against
# `systemctl cat gvmd` on your system — the exact unit/binary path can
# vary slightly by Debian version.
info "Configuring gvmd to accept GMP connections over TCP (port $GMP_PORT)..."
mkdir -p /etc/systemd/system/gvmd.service.d
cat > /etc/systemd/system/gvmd.service.d/override.conf << EOF
[Service]
ExecStart=
ExecStart=/usr/sbin/gvmd --foreground --osp-vt-update=/run/ospd/ospd-openvas.sock --listen-group=_gvm --listen=0.0.0.0 --port=$GMP_PORT
EOF
systemctl daemon-reload
systemctl restart gvmd
sleep 5

if ! ss -tlnp 2>/dev/null | grep -q ":$GMP_PORT "; then
  warn "gvmd doesn't appear to be listening on port $GMP_PORT yet. Check 'systemctl status gvmd' and"
  warn "'journalctl -u gvmd -n 50'. You may need to adjust the ExecStart line in"
  warn "/etc/systemd/system/gvmd.service.d/override.conf to match your gvmd's actual binary path/options"
  warn "(run 'systemctl cat gvmd' before this script's override to see the original for reference)."
else
  success "gvmd is listening on 0.0.0.0:$GMP_PORT."
fi

# Also allow this port through the local firewall, if ufw is active.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$GMP_PORT"/tcp >/dev/null 2>&1 || true
fi

# ─── Register with InfraLoom ───────────────────────────────────────────────
HOST_IP=$(hostname -I | awk '{print $1}')
info "Registering this server ($HOST_IP) with InfraLoom at $INFRALOOM_URL..."

RESPONSE=$(curl -sk -X POST "$INFRALOOM_URL/api/vulnerability/register" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"name\":\"OpenVAS ($HOST_IP)\",\"gmp_host\":\"$HOST_IP\",\"gmp_port\":$GMP_PORT,\"gmp_username\":\"$GVM_USER\",\"gmp_password\":\"$GVM_PASSWORD\"}")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  success "Registered with InfraLoom successfully."
  success "Setup complete. GMP username: $GVM_USER — the password was sent to InfraLoom directly and isn't printed here."
else
  echo "Registration failed. InfraLoom responded: $RESPONSE"
  echo "GVM itself is still running — you can register it manually from the Vulnerability Scan page if needed,"
  echo "or re-run this script with a fresh token (it will skip the parts already done)."
  exit 1
fi

