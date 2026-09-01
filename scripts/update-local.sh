#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

QUICK=false
SKIP_PULL=false

load_kind_images() {
  if ! command -v kind >/dev/null 2>&1; then
    return
  fi

  local current_context
  current_context="$(kubectl config current-context 2>/dev/null || true)"
  if [[ "$current_context" != kind-* ]]; then
    return
  fi

  local cluster_name="${current_context#kind-}"
  if ! kind get clusters 2>/dev/null | grep -qx "$cluster_name"; then
    return
  fi

  echo "[4/5] Loading images into kind cluster '$cluster_name'..."
  kind load docker-image "$@" --name "$cluster_name"
}

usage() {
  echo "Usage: update-local.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --quick, -q    Skip agent image rebuilds (api + web only)"
  echo "  --no-pull       Skip git pull"
  echo "  --help, -h     Show this help"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick|-q) QUICK=true; shift ;;
    --no-pull) SKIP_PULL=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

echo "=== Optio Local Update ==="
echo ""

# Pull latest code
if [ "$SKIP_PULL" = false ]; then
echo "[1/5] Pulling latest code..."
  git pull --rebase
else
  echo "[1/5] Skipping git pull"
fi

# Install any new dependencies
echo "[2/5] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Build images
echo "[3/5] Building images..."

# API and Web always build in parallel
docker build -t optio-api:latest -f Dockerfile.api . -q &
API_PID=$!
docker build -t optio-web:latest -f Dockerfile.web . -q &
WEB_PID=$!

AGENT_IMAGES=()
if [ "$QUICK" = false ]; then
  echo "   Rebuilding agent images..."
  docker build -t optio-base:latest -f images/base.Dockerfile . -q
  docker tag optio-base:latest optio-agent:latest
  docker build -t optio-node:latest -f images/node.Dockerfile . -q &
  docker build -t optio-python:latest -f images/python.Dockerfile . -q &
  docker build -t optio-go:latest -f images/go.Dockerfile . -q &
  docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
  wait
  docker build -t optio-full:latest -f images/full.Dockerfile . -q
  AGENT_IMAGES=(
    optio-base:latest
    optio-agent:latest
    optio-node:latest
    optio-python:latest
    optio-go:latest
    optio-rust:latest
    optio-full:latest
  )

  # Rebuild optio-optio if missing
  if ! docker image inspect "optio-optio:latest" &>/dev/null; then
    echo "   Rebuilding optio-optio (operations assistant)..."
    docker build -t optio-optio:latest -f Dockerfile.optio . -q
  fi
fi

# Wait for API and Web builds
wait $API_PID || { echo "API image build failed"; exit 1; }
wait $WEB_PID || { echo "Web image build failed"; exit 1; }
echo "   Images built."
KIND_IMAGES=(optio-api:latest optio-web:latest)
if [ "$QUICK" = false ] && docker image inspect "optio-optio:latest" &>/dev/null; then
  KIND_IMAGES+=(optio-optio:latest)
fi
if [ "$QUICK" = false ]; then
  KIND_IMAGES+=("${AGENT_IMAGES[@]}")
fi
load_kind_images "${KIND_IMAGES[@]}"

# Rolling restart
echo "[5/5] Restarting deployments..."
# NOTE: --reset-then-reuse-values carries forward the release's existing values,
# including encryption.key. Never pass a freshly generated encryption key here —
# rotating it invalidates all stored secrets (see issue #553 and setup-local.sh).
helm upgrade optio helm/optio -n optio -f helm/optio/values.local.yaml --reset-then-reuse-values

DEPLOYMENTS="deployment/optio-api deployment/optio-web"
if kubectl get deployment optio-optio -n optio &>/dev/null; then
  DEPLOYMENTS="$DEPLOYMENTS deployment/optio-optio"
fi
kubectl rollout restart $DEPLOYMENTS -n optio

for dep in $DEPLOYMENTS; do
  kubectl rollout status "$dep" -n optio --timeout=90s 2>/dev/null || true
done

# Verify health
if curl -sf http://localhost:30400/api/health >/dev/null 2>&1; then
  HEALTH="healthy"
else
  HEALTH="not responding (may still be starting)"
fi

echo ""
echo "=== Update Complete ==="
echo ""
echo "  Web UI ...... http://localhost:30310"
echo "  API ......... http://localhost:30400"
echo "  API health .. $HEALTH"
if [ "$QUICK" = true ]; then
  echo ""
  echo "  (--quick mode: agent images were not rebuilt)"
fi
