#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/infraloom"
SERVICE_NAME="infraloom"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash update.sh"
[ -d "$INSTALL_DIR/.git" ] || error "InfraLoom not found at ${INSTALL_DIR}."

cd "$INSTALL_DIR"

info "Pulling latest changes..."
git pull --ff-only
success "Repository updated."

info "Installing dependencies..."
npm install --no-fund --no-audit --include=dev

info "Running database migration..."
npm run migrate

info "Rebuilding frontend..."
npm run build

info "Restarting service..."
systemctl restart "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  success "InfraLoom updated and running."
else
  error "Service failed to restart — check: journalctl -u ${SERVICE_NAME} -n 50"
fi
