#!/usr/bin/env bash
#
# install-k3s-test.sh — sets up a single-node k3s cluster for testing
# InfraLoom's Kubernetes integration, and creates a dedicated read-only
# service account + long-lived token that InfraLoom can use to connect.
#
# UNTESTED NOTICE: k3s itself could not be run to completion in the
# sandbox this was written in (it refuses to start on cgroup v1, which
# this particular sandbox uses) — but any reasonably current Debian 12 /
# Ubuntu 22.04+ VM uses cgroup v2 by default, so this shouldn't affect
# you. The RBAC/token YAML structure was validated for correct syntax,
# and the official k3s installer is a very stable, widely-used script —
# but you're still the first real end-to-end test of this exact script.
#
# Usage:
#   sudo bash install-k3s-test.sh
#
set -e

info()    { echo -e "\033[36m[info]\033[0m $1"; }
success() { echo -e "\033[32m[ok]\033[0m $1"; }
warn()    { echo -e "\033[33m[warn]\033[0m $1"; }

if [ "$EUID" -ne 0 ]; then
  echo "Run this as root: sudo bash install-k3s-test.sh"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  info "Installing curl..."
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl >/dev/null
fi

# ─── Install k3s ────────────────────────────────────────────────────────────
if ! command -v k3s >/dev/null 2>&1; then
  info "Installing k3s (disabling the bundled traefik/servicelb — not needed for a test/monitoring cluster)..."
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik --disable servicelb" sh -
else
  success "k3s already installed."
fi

# ─── Wait for the API server to actually be ready ──────────────────────────
info "Waiting for the k3s API server to be ready..."
READY=0
for i in $(seq 1 60); do
  if k3s kubectl get --raw='/readyz' </dev/null >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 3
done
if [ "$READY" -ne 1 ]; then
  echo "k3s did not become ready within 3 minutes. Check 'systemctl status k3s' and 'journalctl -u k3s -n 100' for details."
  exit 1
fi
success "k3s API server is ready."

# ─── Create a dedicated read-only service account + durable token ──────────
info "Creating a read-only 'infraloom-readonly' service account..."
cat <<'EOF' | k3s kubectl apply -f - </dev/null
apiVersion: v1
kind: ServiceAccount
metadata:
  name: infraloom-readonly
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: infraloom-readonly
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io", "metrics.k8s.io", "storage.k8s.io"]
    resources: ["*"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: infraloom-readonly
subjects:
  - kind: ServiceAccount
    name: infraloom-readonly
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: infraloom-readonly
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: Secret
metadata:
  name: infraloom-readonly-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: infraloom-readonly
type: kubernetes.io/service-account-token
EOF

# The token Secret's data is populated asynchronously by the controller
# manager — poll briefly rather than assuming it's there immediately.
info "Waiting for the token to be issued..."
TOKEN=""
for i in $(seq 1 20); do
  TOKEN=$(k3s kubectl get secret infraloom-readonly-token -n kube-system -o jsonpath='{.data.token}' </dev/null 2>/dev/null | base64 -d 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then break; fi
  sleep 2
done
if [ -z "$TOKEN" ]; then
  echo "Token was not issued in time. Check manually with: k3s kubectl get secret infraloom-readonly-token -n kube-system -o yaml"
  exit 1
fi
success "Token issued."

# ─── Report connection details ─────────────────────────────────────────────
NODE_IP=$(hostname -I | awk '{print $1}')
API_SERVER="https://${NODE_IP}:6443"

echo
echo "=================================================================="
echo " Cluster ready for InfraLoom to connect to:"
echo
echo " API server URL : $API_SERVER"
echo " Service account : infraloom-readonly (read-only, kube-system)"
echo " Token           :"
echo "$TOKEN"
echo
echo " Save these — the token is only shown here. InfraLoom's connection"
echo " form will ask for the API server URL and this token."
echo "=================================================================="
