#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

QUICK=false
SKIP_PULL=false
LOCAL_IMAGE_TAG=""

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

  echo "   Loading images into kind cluster '$cluster_name'..."
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
  echo "[1/4] Pulling latest code..."
  git pull --rebase
else
  echo "[1/4] Skipping git pull"
fi
LOCAL_IMAGE_TAG="local-$(git rev-parse --short=12 HEAD)"

# Install any new dependencies
echo "[2/4] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Build images
echo "[3/4] Building images..."
echo "   Deployment image tag: $LOCAL_IMAGE_TAG"

# API and Web always build in parallel
docker build -t optio-api:latest -f Dockerfile.api . -q &
API_PID=$!
docker build -t optio-web:latest -f Dockerfile.web . -q &
WEB_PID=$!

if [ "$QUICK" = false ]; then
  # Check if any agent image needs rebuilding
  REBUILD_AGENTS=false
  for preset in base node python go rust full; do
    if ! docker image inspect "optio-${preset}:latest" &>/dev/null; then
      REBUILD_AGENTS=true
      break
    fi
  done

  if [ "$REBUILD_AGENTS" = true ]; then
    echo "   Rebuilding agent images (new presets detected)..."
    docker build -t optio-base:latest -f images/base.Dockerfile . -q
    docker tag optio-base:latest optio-agent:latest
    docker build -t optio-node:latest -f images/node.Dockerfile . -q &
    docker build -t optio-python:latest -f images/python.Dockerfile . -q &
    docker build -t optio-go:latest -f images/go.Dockerfile . -q &
    docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
    wait
    docker build -t optio-full:latest -f images/full.Dockerfile . -q
  fi

  # Rebuild optio-optio if missing
  if ! docker image inspect "optio-optio:latest" &>/dev/null; then
    echo "   Rebuilding optio-optio (operations assistant)..."
    docker build -t optio-optio:latest -f Dockerfile.optio . -q
  fi
fi

# Wait for API and Web builds
wait $API_PID || { echo "API image build failed"; exit 1; }
wait $WEB_PID || { echo "Web image build failed"; exit 1; }
docker tag optio-api:latest "optio-api:$LOCAL_IMAGE_TAG"
docker tag optio-web:latest "optio-web:$LOCAL_IMAGE_TAG"
load_kind_images "optio-api:$LOCAL_IMAGE_TAG" "optio-web:$LOCAL_IMAGE_TAG"
echo "   Images built."

# Deploy immutable tags. Reusing Helm values without explicit tags can retain
# old images, producing a successful rollout that serves stale code.
echo "[4/4] Deploying freshly built images..."
# A new encryption key makes every credential already stored in Postgres
# unreadable. An update must reuse the cluster's existing key and fail before
# changing the release if it cannot find one; setup-local.sh is responsible for
# generating the key on first installation.
ENCRYPTION_KEY="$(kubectl get secret optio-config -n optio \
  -o jsonpath='{.data.OPTIO_ENCRYPTION_KEY}' 2>/dev/null | base64 -d || true)"
if [ -z "$ENCRYPTION_KEY" ]; then
  echo "Cannot read the existing Optio encryption key from optio-config." >&2
  echo "Run ./scripts/setup-local.sh to initialize the local cluster." >&2
  exit 1
fi
helm upgrade optio helm/optio -n optio -f helm/optio/values.local.yaml --reuse-values \
  --set-string "encryption.key=$ENCRYPTION_KEY" \
  --set "api.image.tag=$LOCAL_IMAGE_TAG" \
  --set "web.image.tag=$LOCAL_IMAGE_TAG"

DEPLOYMENTS="deployment/optio-api deployment/optio-web"
if kubectl get deployment optio-optio -n optio &>/dev/null; then
  DEPLOYMENTS="$DEPLOYMENTS deployment/optio-optio"
fi
for dep in $DEPLOYMENTS; do
  kubectl rollout status "$dep" -n optio --timeout=120s
done

# Verify both the running image references and the local endpoints. A Helm
# success alone is not evidence that the rebuilt UI/API is what pods serve.
API_IMAGE="$(kubectl get deployment optio-api -n optio -o jsonpath='{.spec.template.spec.containers[0].image}')"
WEB_IMAGE="$(kubectl get deployment optio-web -n optio -o jsonpath='{.spec.template.spec.containers[0].image}')"
if [ "$API_IMAGE" != "optio-api:$LOCAL_IMAGE_TAG" ] || [ "$WEB_IMAGE" != "optio-web:$LOCAL_IMAGE_TAG" ]; then
  echo "Deployment image verification failed:" >&2
  echo "  API: $API_IMAGE (expected optio-api:$LOCAL_IMAGE_TAG)" >&2
  echo "  Web: $WEB_IMAGE (expected optio-web:$LOCAL_IMAGE_TAG)" >&2
  exit 1
fi
curl -fsS http://localhost:30400/api/health >/dev/null
curl -fsSI http://localhost:30310 >/dev/null

echo ""
echo "=== Update Complete ==="
echo ""
echo "  Web UI ...... http://localhost:30310"
echo "  API ......... http://localhost:30400"
echo "  API health .. healthy"
echo "  API image ... $API_IMAGE"
echo "  Web image ... $WEB_IMAGE"
if [ "$QUICK" = true ]; then
  echo ""
  echo "  (--quick mode: agent images were not rebuilt)"
fi
