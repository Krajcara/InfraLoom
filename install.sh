#!/usr/bin/env bash
set -euo pipefail

# ─── InfraLoom Installer ───────────────────────────────────────────────────
# Usage: sudo bash install.sh [GITHUB_TOKEN]
#
# EDIT THESE before first use if you forked/renamed the repo:
REPO_OWNER="krajcara"
REPO_NAME="InfraLoom"
INSTALL_DIR="/opt/infraloom"
SERVICE_NAME="infraloom"
NODE_VERSION="22"
APP_PORT="3000"
APP_VERSION="0.1.0"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ─── Root check ─────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Run as root: sudo bash install.sh [GITHUB_TOKEN]"

GITHUB_TOKEN="${1:-}"
if [ -z "$GITHUB_TOKEN" ]; then
  warn "No GitHub token provided — using public (unauthenticated) access."
  warn "For private repos: sudo bash install.sh <GITHUB_TOKEN>"
  CLONE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
else
  CLONE_URL="https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi

echo ""
echo "  InfraLoom Installer v${APP_VERSION}"
echo "  Powered by Krajcara"
echo ""

# ─── System packages ─────────────────────────────────────────────────────────
info "Installing system packages (curl, git, build tools, nmap, arp-scan)..."
apt-get update -qq
apt-get install -y -qq curl git build-essential python3 nmap arp-scan sqlite3 ca-certificates openssl iputils-ping >/dev/null
success "System packages installed."

# arp-scan and nmap's SYN/UDP scan modes need raw-socket access, which
# normally means running as root. Instead of running the whole app as root,
# grant just these two binaries the specific Linux capability they need —
# the InfraLoom service itself keeps running as an unprivileged user.
info "Granting arp-scan/nmap raw-socket capability (Network Scanner)..."
ARPSCAN_BIN="$(command -v arp-scan || true)"
NMAP_BIN="$(command -v nmap || true)"
[ -n "$ARPSCAN_BIN" ] && setcap cap_net_raw+ep "$ARPSCAN_BIN" 2>/dev/null || warn "Could not setcap arp-scan — Network Scanner will need sudo/root."
[ -n "$NMAP_BIN" ] && setcap cap_net_raw,cap_net_admin+eip "$NMAP_BIN" 2>/dev/null || warn "Could not setcap nmap — deep scans will fall back to a slower connect scan."

# ─── Node.js via nvm ────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_VERSION}.* ]]; then
  info "Installing Node.js ${NODE_VERSION} LTS via nvm..."
  export NVM_DIR="/usr/local/nvm"
  mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION" >/dev/null
  nvm alias default "$NODE_VERSION" >/dev/null
  ln -sf "$NVM_DIR/versions/node/$(nvm version "$NODE_VERSION")/bin/node" /usr/bin/node
  ln -sf "$NVM_DIR/versions/node/$(nvm version "$NODE_VERSION")/bin/npm"  /usr/bin/npm
  success "Node.js $(node -v) installed."
else
  success "Node.js $(node -v) already installed."
fi

# ─── Clone or update repo ───────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing installation found at ${INSTALL_DIR} — pulling latest changes..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning ${REPO_NAME} into ${INSTALL_DIR}..."
  git clone "$CLONE_URL" "$INSTALL_DIR"
fi
success "Repository ready at ${INSTALL_DIR}."

cd "$INSTALL_DIR"

# ─── .env setup ─────────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.env" ]; then
  info "Generating .env with random secrets..."
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  APP_SECRET_VALUE="$(openssl rand -hex 64)"
  DB_KEY_VALUE="$(openssl rand -hex 32)"
  sed -i "s|^APP_SECRET=.*|APP_SECRET=${APP_SECRET_VALUE}|"       "$INSTALL_DIR/.env"
  sed -i "s|^DB_ENCRYPTION_KEY=.*|DB_ENCRYPTION_KEY=${DB_KEY_VALUE}|" "$INSTALL_DIR/.env"
  sed -i "s|^APP_PORT=.*|APP_PORT=${APP_PORT}|"                   "$INSTALL_DIR/.env"
  [ -n "$GITHUB_TOKEN" ] && sed -i "s|^GITHUB_TOKEN=.*|GITHUB_TOKEN=${GITHUB_TOKEN}|" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  success ".env created with a freshly generated APP_SECRET and DB_ENCRYPTION_KEY."
  warn "Back up DB_ENCRYPTION_KEY securely — losing it means losing access to all data."
else
  info ".env already exists — leaving it untouched."
fi

# NOTE: we deliberately do NOT `source .env` here. The app itself loads .env
# via dotenv at runtime (migrate.js/seed.js/index.js). Exporting NODE_ENV=
# production into this installer's shell would make npm skip devDependencies
# (vite, nodemon, ...) during install/build, breaking the frontend build.

# ─── Install dependencies & build ──────────────────────────────────────────
info "Installing dependencies (this can take a minute)..."
npm install --no-fund --no-audit --include=dev
success "Dependencies installed."

info "Building the frontend..."
npm run build
success "Frontend built."

# ─── Database migration + initial superadmin ───────────────────────────────
info "Running database migration..."
npm run migrate
success "Database schema ready (encrypted with SQLCipher)."

info "Creating initial superadmin account (if none exists)..."
npm run seed
# ── seed.js prints the username/password/login URL itself — captured above ──

# ─── systemd service ────────────────────────────────────────────────────────
info "Installing systemd service..."
cp "$INSTALL_DIR/infraloom.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  success "InfraLoom service is running."
else
  error "InfraLoom service failed to start — check: journalctl -u ${SERVICE_NAME} -n 50"
fi

SERVER_IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  InfraLoom installed successfully."
echo "  Login URL : http://${SERVER_IP}:${APP_PORT}"
echo "  (Superadmin username/password were printed above — save them now.)"
echo "════════════════════════════════════════════════════════════"
echo ""
