#!/usr/bin/env bash
#
# install-openvas.sh — installs Greenbone Community Edition (OpenVAS) via
# Docker Compose, using Greenbone's own official compose file, and
# registers itself with InfraLoom via SSH access (not GMP/TCP — Greenbone's
# official compose setup only exposes GMP over an internal unix socket,
# reached via the bundled gvm-tools container; InfraLoom talks to it by
# SSHing into this host and running `docker compose exec gvm-tools gvm-cli`).
#
# UNTESTED NOTICE: Docker isn't available in the sandbox this was written
# in, so the actual `docker compose up` + feed sync could not be run here.
# The compose file itself was fetched directly from Greenbone's own docs
# repo (https://github.com/greenbone/docs, src/_static/compose.yaml) as of
# writing, so it should be current — but you're still the first real test
# of this exact script end-to-end.
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

GVM_DIR="/opt/greenbone"

# ─── SSH access for InfraLoom ──────────────────────────────────────────────
# InfraLoom talks to this host over SSH (not GMP/TCP — see notice above).
# Fetch InfraLoom's own management public key and add it to root's
# authorized_keys, the same key InfraLoom already uses for VMs it creates
# itself via its Automation module.
info "Fetching InfraLoom's management SSH key..."
PUBKEY=$(curl -sk "$INFRALOOM_URL/api/vulnerability/management-key" | grep -oE '"publicKey":"[^"]+"' | sed -E 's/"publicKey":"([^"]+)"/\1/')
if [ -z "$PUBKEY" ]; then
  echo "Could not fetch InfraLoom's management key from $INFRALOOM_URL — check the URL is reachable from this VM."
  exit 1
fi
mkdir -p /root/.ssh && chmod 700 /root/.ssh
grep -qxF "$PUBKEY" /root/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
success "InfraLoom's key added to root's authorized_keys."

# ─── Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  success "Docker installed."
else
  success "Docker already installed."
fi

if ! docker compose version >/dev/null 2>&1 </dev/null; then
  echo "Docker Compose plugin not found — check 'docker compose version' manually, the Docker install above should include it."
  exit 1
fi

# ─── Greenbone Community Edition (official compose file) ──────────────────
mkdir -p "$GVM_DIR"
cd "$GVM_DIR"

if [ ! -f docker-compose.yml ]; then
  info "Downloading Greenbone's official compose file..."
  curl -fsSL -o docker-compose.yml \
    https://raw.githubusercontent.com/greenbone/docs/main/src/_static/compose.yaml \
    || { echo "Could not download the compose file — check https://github.com/greenbone/docs/blob/main/src/_static/compose.yaml is still there, download it manually to $GVM_DIR/docker-compose.yml, then re-run this script."; exit 1; }
fi

info "Starting Greenbone containers (pulls a number of images from registry.community.greenbone.net, may take a while)..."
docker compose up -d </dev/null

info "Waiting for the vulnerability-test feed to finish its first sync — this is normally the slow part,"
info "1-3+ hours on a fresh install. Watch progress with: docker compose -f $GVM_DIR/docker-compose.yml logs -f vulnerability-tests"
info "This script polls every 2 minutes and continues once gvmd is responding."

READY=0
for i in $(seq 1 90); do  # up to ~3 hours
  if docker compose exec -T -u gvmd gvmd gvmd --get-users >/dev/null 2>&1 </dev/null; then
    READY=1
    break
  fi
  sleep 120
done

if [ "$READY" -ne 1 ]; then
  echo "gvmd did not become ready within the expected time. Check 'docker compose logs gvmd' in $GVM_DIR and re-run this script once it's healthy — it will pick up from here."
  exit 1
fi
success "Greenbone stack is up."

# ─── Dedicated GMP user for InfraLoom ──────────────────────────────────────
info "Creating a dedicated 'infraloom' GMP user (rather than using the built-in admin account)..."
GVM_USER="infraloom"
GVM_PASSWORD=$(openssl rand -hex 16)
if ! docker compose exec -T -u gvmd gvmd gvmd --create-user="$GVM_USER" --new-password="$GVM_PASSWORD" </dev/null; then
  info "'$GVM_USER' likely already exists from an earlier attempt — resetting its password instead."
  if ! docker compose exec -T -u gvmd gvmd gvmd --user="$GVM_USER" --new-password="$GVM_PASSWORD" </dev/null; then
    echo "Could not create or reset the '$GVM_USER' GMP user. Check 'docker compose logs gvmd' in $GVM_DIR, fix manually, then re-run this script with a fresh token."
    exit 1
  fi
fi
docker compose exec -T -u gvmd gvmd gvmd --role=Admin --user="$GVM_USER" 2>/dev/null </dev/null || warn "Could not confirm the Admin role was granted — check manually if scans don't work."

# ─── Register with InfraLoom ───────────────────────────────────────────────
HOST_IP=$(hostname -I | awk '{print $1}')
info "Registering this server ($HOST_IP) with InfraLoom at $INFRALOOM_URL..."

RESPONSE=$(curl -sk -X POST "$INFRALOOM_URL/api/vulnerability/register" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"name\":\"OpenVAS ($HOST_IP)\",\"ssh_host\":\"$HOST_IP\",\"ssh_port\":22,\"ssh_username\":\"root\",\"compose_path\":\"$GVM_DIR/docker-compose.yml\",\"gmp_username\":\"$GVM_USER\",\"gmp_password\":\"$GVM_PASSWORD\"}")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  success "Registered with InfraLoom successfully."
  success "Setup complete. GMP username: $GVM_USER — the password was sent to InfraLoom directly and isn't printed here."
else
  echo "Registration failed. InfraLoom responded: $RESPONSE"
  echo "Greenbone itself is still running — you can register it manually from the Vulnerability Scan page if needed,"
  echo "or re-run this script with a fresh token (it will skip the parts already done)."
  exit 1
fi
