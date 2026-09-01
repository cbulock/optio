#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

ENSURE_KIND=false
HOST_BIND_ADDRESS="${OPTIO_HOST_BIND_ADDRESS:-127.0.0.1}"

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

  echo "[4/7] Loading images into kind cluster '$cluster_name'..."
  kind load docker-image "$@" --name "$cluster_name"
}

usage() {
  cat <<EOF
Usage: ./scripts/setup-local.sh [OPTIONS]

Options:
  --ensure-kind                 Create the default kind cluster if none exists
  --host-bind-address ADDR      Host bind address to use with --ensure-kind
                                (default: \$OPTIO_HOST_BIND_ADDRESS or 127.0.0.1)
  --lan                         Shortcut for --host-bind-address 0.0.0.0
  -h, --help                    Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ensure-kind)
      ENSURE_KIND=true
      shift
      ;;
    --host-bind-address)
      HOST_BIND_ADDRESS="${2:?missing host bind address}"
      shift 2
      ;;
    --lan)
      ENSURE_KIND=true
      HOST_BIND_ADDRESS="0.0.0.0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

echo "=== Optio Local Setup ==="
echo ""

# Check prerequisites
command -v kubectl >/dev/null 2>&1 || { echo "❌ kubectl is required. Enable Kubernetes in Docker Desktop."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ pnpm is required. Install with: npm install -g pnpm"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "❌ docker is required. Install Docker Desktop."; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "❌ helm is required. Install with: brew install helm"; exit 1; }

# Check cluster connectivity
if ! kubectl cluster-info >/dev/null 2>&1; then
  if [ "$ENSURE_KIND" = true ]; then
    echo "No Kubernetes cluster found. Creating kind cluster 'optio-local'..."
    "$ROOT_DIR/scripts/create-local-kind.sh" \
      --name optio-local \
      --host-bind-address "$HOST_BIND_ADDRESS"
    kubectl config use-context kind-optio-local >/dev/null
  else
    echo "❌ No Kubernetes cluster found."
    echo "   Enable Kubernetes in Docker Desktop or create a local kind cluster:"
    echo "   ./scripts/create-local-kind.sh --lan"
    exit 1
  fi
fi

# Check Kubernetes version (v1.33+ required for post-quantum TLS)
K8S_SERVER_VERSION=$(kubectl version --output=json 2>/dev/null | grep -oE '"gitVersion":[[:space:]]*"v[0-9]+\.[0-9]+' | tail -1 | grep -oE '[0-9]+\.[0-9]+' || true)
if [ -n "$K8S_SERVER_VERSION" ]; then
  K8S_MAJOR=$(echo "$K8S_SERVER_VERSION" | cut -d. -f1)
  K8S_MINOR=$(echo "$K8S_SERVER_VERSION" | cut -d. -f2)
  if [ "$K8S_MAJOR" -lt 1 ] || { [ "$K8S_MAJOR" -eq 1 ] && [ "$K8S_MINOR" -lt 33 ]; }; then
    echo "⚠ WARNING: Kubernetes v${K8S_SERVER_VERSION} detected. Optio requires v1.33+ for"
    echo "  post-quantum TLS on the control plane. v1.33 is the first release built on"
    echo "  Go 1.24, which enables hybrid X25519MLKEM768 key exchange automatically."
    echo "  Update Docker Desktop or your cluster to Kubernetes v1.33+."
    echo ""
  fi
fi

echo "[1/6] Installing dependencies..."
pnpm install

echo "[2/6] Building agent images..."
echo "   Building optio-base (required)..."
docker build -t optio-base:latest -f images/base.Dockerfile . -q
docker tag optio-base:latest optio-agent:latest
echo "   Building optio-node..."
docker build -t optio-node:latest -f images/node.Dockerfile . -q &
echo "   Building optio-python..."
docker build -t optio-python:latest -f images/python.Dockerfile . -q &
echo "   Building optio-go..."
docker build -t optio-go:latest -f images/go.Dockerfile . -q &
echo "   Building optio-rust..."
docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
echo "   Building optio-optio (operations assistant)..."
docker build -t optio-optio:latest -f Dockerfile.optio . -q &
wait
echo "   Building optio-full..."
docker build -t optio-full:latest -f images/full.Dockerfile . -q
echo "   All agent images built."

echo "[3/6] Building API and Web images..."
docker build -t optio-api:latest -f Dockerfile.api . -q
docker build -t optio-web:latest -f Dockerfile.web . -q
echo "   API and Web images built."

load_kind_images \
  optio-base:latest \
  optio-agent:latest \
  optio-node:latest \
  optio-python:latest \
  optio-go:latest \
  optio-rust:latest \
  optio-full:latest \
  optio-optio:latest \
  optio-api:latest \
  optio-web:latest

echo "[5/7] Installing metrics-server..."
if kubectl get deployment metrics-server -n kube-system &>/dev/null; then
  echo "   metrics-server already installed, skipping"
else
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml 2>/dev/null || {
    echo "   ⚠ Failed to install metrics-server (resource utilization will show N/A)"
  }
  # Docker Desktop / kind / minikube need --kubelet-insecure-tls
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' 2>/dev/null || true
  echo "   metrics-server installed (may take a minute to become ready)"
fi

echo "[6/7] Deploying Optio to Kubernetes via Helm..."
# Reuse the existing encryption key if the release already has one. Rotating the
# key invalidates every secret stored in Postgres (AES-256-GCM decryption fails
# with "Unsupported state or unable to authenticate data") — see issue #553.
ENCRYPTION_KEY=$(kubectl get secret optio-config -n optio \
  -o jsonpath='{.data.OPTIO_ENCRYPTION_KEY}' 2>/dev/null | base64 -d || true)
if [ -n "$ENCRYPTION_KEY" ]; then
  echo "   Reusing existing encryption key from optio-config secret."
else
  echo "   Generating new encryption key..."
  ENCRYPTION_KEY=$(openssl rand -hex 32)
fi

if helm status optio -n optio &>/dev/null; then
  echo "   Existing release found, upgrading..."
  helm upgrade optio helm/optio -n optio \
    -f helm/optio/values.local.yaml \
    --set encryption.key="$ENCRYPTION_KEY" \
    --wait --timeout=120s
else
  helm install optio helm/optio -n optio --create-namespace \
    -f helm/optio/values.local.yaml \
    --set encryption.key="$ENCRYPTION_KEY" \
    --wait --timeout=120s
fi
echo "   Helm deployment complete."

echo "[7/7] Verifying deployment..."
kubectl wait --namespace optio --for=condition=available deployment/optio-api --timeout=60s 2>/dev/null || true
kubectl wait --namespace optio --for=condition=available deployment/optio-web --timeout=60s 2>/dev/null || true
kubectl wait --namespace optio --for=condition=available deployment/optio-optio --timeout=60s 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
if kind get clusters 2>/dev/null | grep -qx optio-local; then
  CONTROL_PLANE_CONTAINER="optio-local-control-plane"
  PORT_BINDINGS="$(docker inspect "$CONTROL_PLANE_CONTAINER" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || true)"
  if echo "$PORT_BINDINGS" | grep -q '"HostIp":"127.0.0.1"'; then
    echo "Note:"
    echo "  The current kind port mappings are loopback-only."
    echo "  LAN access will fail until you recreate the cluster with:"
    echo "  ./scripts/create-local-kind.sh --delete"
    echo "  ./scripts/create-local-kind.sh --lan"
    echo ""
  fi
fi
echo "Services:"
echo "  Web UI ...... http://localhost:30310"
echo "  API ......... http://localhost:30400"
echo "  Postgres .... optio-postgres:5432 (K8s internal)"
echo "  Redis ....... optio-redis:6379 (K8s internal)"
echo ""
echo "Agent images:"
docker images --filter "reference=optio-*" --format "  {{.Repository}}:{{.Tag}}" 2>/dev/null || true
echo ""
echo "Next steps:"
echo ""
echo "  1. Open the setup wizard:"
echo "     http://localhost:30310/setup"
echo ""
echo "  2. After rebuilding images, redeploy with:"
echo "     docker build -t optio-api:latest -f Dockerfile.api ."
echo "     docker build -t optio-web:latest -f Dockerfile.web ."
echo "     kind load docker-image optio-api:latest optio-web:latest --name optio-local"
echo "     kubectl rollout restart deployment/optio-api deployment/optio-web -n optio"
echo ""
echo "To tear down:"
echo "  helm uninstall optio -n optio"
