#!/usr/bin/env bash
#
# install-openvas.sh — sets up Greenbone Community Edition (OpenVAS) via
# Docker Compose on a dedicated VM, exposes GMP over TCP so InfraLoom (on
# a different host) can connect, and registers itself with InfraLoom
# automatically at the end.
#
# UNTESTED NOTICE: this script could not be run against a real OpenVAS/GVM
# stack while writing it (the sandbox this was built in can't run Docker
# with the resources or time a multi-GB feed sync needs). The structure
# follows Greenbone's documented Community Container deployment, but you
# are the first real test of this exact script — read through it before
# running, and expect to troubleshoot the Greenbone-specific steps
# (docker-compose.yml contents, exact container/service names, the admin
# password retrieval command) against Greenbone's own current docs if
# anything doesn't match, since those details can change between releases.
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
  echo "Run this as root (sudo bash install-openvas.sh ...)"
  exit 1
fi

GVM_DIR="/opt/greenbone"
GMP_PORT=9390

# ─── Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  success "Docker installed."
else
  success "Docker already installed."
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin not found — install.sh's Docker install should include it. Check 'docker compose version' manually."
  exit 1
fi

# ─── Greenbone Community Containers ────────────────────────────────────────
# Pulls Greenbone's official docker-compose setup. VERIFY this URL is still
# current — check https://greenbone.github.io/docs/latest/22.4/container/
# if this 404s or the compose file looks different from what's expected.
mkdir -p "$GVM_DIR"
cd "$GVM_DIR"

if [ ! -f docker-compose.yml ]; then
  info "Downloading Greenbone Community Containers compose file..."
  curl -fsSL -o docker-compose.yml \
    https://raw.githubusercontent.com/greenbone/gvm-docker/main/docker-compose.yml \
    || { echo "Could not download docker-compose.yml — check the Greenbone docs for the current URL, download it manually to $GVM_DIR/docker-compose.yml, then re-run this script."; exit 1; }
fi

# Expose GMP over TCP (not just the internal docker network / unix socket)
# so InfraLoom, on a different host, can reach it. VERIFY this against the
# compose file just downloaded — the exact service name and args may differ.
if ! grep -q "9390:9390" docker-compose.yml; then
  warn "docker-compose.yml doesn't already expose port 9390 — you likely need to add it to the gvmd service."
  warn "Edit $GVM_DIR/docker-compose.yml: add 'ports: [\"9390:9390\"]' under gvmd, and make sure its command/args include --listen=0.0.0.0 --port=9390."
fi

info "Starting Greenbone containers (this pulls several images, may take a few minutes)..."
docker compose up -d

info "Waiting for the NVT feed to finish its first sync — this is normally the slow part, 1-3+ hours on a fresh install."
info "Watch progress in another terminal with: docker compose -f $GVM_DIR/docker-compose.yml logs -f gvmd"
info "This script polls every 2 minutes and continues once gvmd reports it's ready."

READY=0
for i in $(seq 1 90); do  # up to ~3 hours
  if docker compose exec -T gvmd gvmd --get-users >/dev/null 2>&1; then
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

# ─── GMP API user for InfraLoom ────────────────────────────────────────────
# Greenbone's container entrypoint normally creates an initial admin user
# and prints its generated password to the gvmd container logs on first
# start. VERIFY the exact log line — this grep pattern is a best guess and
# may need adjusting to match what your version actually prints.
info "Looking up the admin password from the gvmd container logs..."
GVM_PASSWORD=$(docker compose logs gvmd 2>&1 | grep -i "password" | grep -oE "[A-Za-z0-9]{16,}" | head -1 || true)

if [ -z "$GVM_PASSWORD" ]; then
  warn "Couldn't automatically find the generated admin password in the logs."
  warn "Run 'docker compose logs gvmd' in $GVM_DIR yourself, find the admin password, then create a dedicated API user for InfraLoom with:"
  warn "  docker compose exec gvmd gvmd --create-user=infraloom --new-password=<a-strong-password>"
  warn "  docker compose exec gvmd gvmd --role=Admin --user=infraloom"
  read -rp "Enter the password to register with InfraLoom (for the 'infraloom' GMP user, or 'admin' if you're using that instead): " GVM_PASSWORD
  GVM_USER="infraloom"
else
  info "Creating a dedicated 'infraloom' API user (rather than using the admin account directly)..."
  GVM_API_PASSWORD=$(openssl rand -hex 16)
  docker compose exec -T gvmd gvmd --create-user=infraloom --new-password="$GVM_API_PASSWORD" || true
  docker compose exec -T gvmd gvmd --role=Admin --user=infraloom || true
  GVM_PASSWORD="$GVM_API_PASSWORD"
  GVM_USER="infraloom"
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
  echo "The OpenVAS server itself is still running — you can register it manually from the Vulnerability Scan page if needed, or re-run this script with a fresh token."
  exit 1
fi
