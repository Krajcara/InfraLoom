#!/usr/bin/env bash
set -euo pipefail

# ─── InfraLoom Updater ──────────────────────────────────────────────────────
# Checks GitHub for a newer release (or new commits if no releases exist yet),
# pulls if available, rebuilds and restarts.
# Usage: sudo bash /opt/infraloom/update.sh
#
INSTALL_DIR="/opt/infraloom"
SERVICE_NAME="infraloom"
REPO_OWNER="krajcara"
REPO_NAME="InfraLoom"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash update.sh"
[ -d "$INSTALL_DIR/.git" ] || error "InfraLoom not found at ${INSTALL_DIR}."

echo ""
info "InfraLoom — Update check"
echo ""

# ─── Load .env ────────────────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
[ -f "$ENV_FILE" ] || error ".env not found at $ENV_FILE — is the app installed?"

GITHUB_TOKEN=$(grep -E '^GITHUB_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
APP_PORT=$(grep -E '^APP_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "3000")

if [ -z "$GITHUB_TOKEN" ]; then
  warn "No GITHUB_TOKEN in .env — using public (unauthenticated) access."
fi

# ─── Current installed version ─────────────────────────────────────────────────
CURRENT_VERSION="unknown"
if [ -f "$INSTALL_DIR/server/package.json" ]; then
  CURRENT_VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$INSTALL_DIR/server/package.json" 2>/dev/null | head -1 || echo "unknown")
fi
info "Installed version: $CURRENT_VERSION"

# ─── Check GitHub for latest release ───────────────────────────────────────────
info "Checking GitHub for latest release..."
CURL_AUTH=""
[ -n "$GITHUB_TOKEN" ] && CURL_AUTH="-H \"Authorization: token ${GITHUB_TOKEN}\""

LATEST_JSON=$(curl -sf $CURL_AUTH \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" \
  --max-time 15 2>/dev/null || echo "")

if [ -z "$LATEST_JSON" ]; then
  info "No releases found — checking for new commits on main branch instead..."
  REMOTE_SHA=$(git -C "$INSTALL_DIR" ls-remote origin HEAD 2>/dev/null | awk '{print $1}' | head -c 7 || echo "")
  LOCAL_SHA=$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo "")

  if [ -z "$REMOTE_SHA" ]; then
    warn "Cannot reach GitHub. Check your internet connection."
    exit 0
  fi

  if [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then
    success "Already up to date (commit: $LOCAL_SHA)"
    exit 0
  fi

  info "New commits available (local: $LOCAL_SHA → remote: $REMOTE_SHA)"
  LATEST_VERSION="latest commit"
else
  LATEST_VERSION=$(echo "$LATEST_JSON" | grep -oP '"tag_name":\s*"\K[^"]+' | sed 's/^v//' || echo "")

  if [ -z "$LATEST_VERSION" ]; then
    warn "Could not parse latest release version."
    exit 0
  fi

  info "Latest release: $LATEST_VERSION"

  if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
    success "Already on latest version ($CURRENT_VERSION)"
    exit 0
  fi
fi

# ─── Pull latest code ───────────────────────────────────────────────────────────
info "Updating to $LATEST_VERSION..."

if [ -n "$GITHUB_TOKEN" ]; then
  git -C "$INSTALL_DIR" remote set-url origin \
    "https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
  chmod 600 "$INSTALL_DIR/.git/config"
else
  git -C "$INSTALL_DIR" remote set-url origin \
    "https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi

git -C "$INSTALL_DIR" fetch origin 2>&1 | tail -3
git -C "$INSTALL_DIR" reset --hard origin/main 2>&1 | tail -3
success "Code updated"

cd "$INSTALL_DIR"

# ─── Reinstall dependencies ───────────────────────────────────────────────────
# NOTE: deliberately do NOT source .env here — NODE_ENV=production would make
# npm skip devDependencies (vite, ...) and break the build. See install.sh.
info "Updating dependencies..."
unset NODE_ENV
npm install --no-fund --no-audit --include=dev 2>&1 | tail -5

# ─── Database migration ────────────────────────────────────────────────────────
info "Running database migration..."
npm run migrate 2>&1 | tail -5

# ─── Rebuild frontend ───────────────────────────────────────────────────────────
info "Rebuilding frontend..."
npm run build 2>&1 | tail -5
[ -d "$INSTALL_DIR/client/dist" ] || error "Frontend build failed"
success "Frontend rebuilt"

# ─── Restart service ────────────────────────────────────────────────────────────
info "Restarting service..."
systemctl restart "$SERVICE_NAME"
sleep 6

if systemctl is-active --quiet "$SERVICE_NAME"; then
  success "Service restarted"
else
  error "Service failed to restart. Check: journalctl -u $SERVICE_NAME -n 50"
fi

# ─── Health check ───────────────────────────────────────────────────────────────
for i in $(seq 1 10); do
  if curl -sf "http://localhost:${APP_PORT}/api/health" > /dev/null 2>&1; then
    echo ""
    success "InfraLoom updated and running on port ${APP_PORT}"
    echo ""
    exit 0
  fi
  sleep 3
done
warn "Health check timed out. Check: journalctl -u $SERVICE_NAME -n 30"
