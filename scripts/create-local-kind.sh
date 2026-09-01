#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="optio-local"
HOST_BIND_ADDRESS="127.0.0.1"
API_PORT="30400"
WEB_PORT="30310"
DELETE=false

usage() {
  cat <<EOF
Usage: ./scripts/create-local-kind.sh [OPTIONS]

Create or delete the local kind cluster used by Optio development.

Options:
  --name NAME                 Cluster name (default: optio-local)
  --host-bind-address ADDR    Host bind address for published ports
                              (default: 127.0.0.1)
  --api-port PORT             Host/container port for the API (default: 30400)
  --web-port PORT             Host/container port for the web UI (default: 30310)
  --lan                       Shortcut for --host-bind-address 0.0.0.0
  --delete                    Delete the cluster instead of creating it
  -h, --help                  Show this help

Examples:
  ./scripts/create-local-kind.sh
  ./scripts/create-local-kind.sh --lan
  ./scripts/create-local-kind.sh --host-bind-address 10.0.0.54
  ./scripts/create-local-kind.sh --delete
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      CLUSTER_NAME="${2:?missing cluster name}"
      shift 2
      ;;
    --host-bind-address)
      HOST_BIND_ADDRESS="${2:?missing host bind address}"
      shift 2
      ;;
    --api-port)
      API_PORT="${2:?missing api port}"
      shift 2
      ;;
    --web-port)
      WEB_PORT="${2:?missing web port}"
      shift 2
      ;;
    --lan)
      HOST_BIND_ADDRESS="0.0.0.0"
      shift
      ;;
    --delete)
      DELETE=true
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

command -v kind >/dev/null 2>&1 || {
  echo "kind is required. Install it from https://kind.sigs.k8s.io/" >&2
  exit 1
}
command -v kubectl >/dev/null 2>&1 || {
  echo "kubectl is required." >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  echo "docker is required." >&2
  exit 1
}

if [[ "$DELETE" == true ]]; then
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    echo "Deleting kind cluster '$CLUSTER_NAME'..."
    kind delete cluster --name "$CLUSTER_NAME"
  else
    echo "Kind cluster '$CLUSTER_NAME' does not exist."
  fi
  exit 0
fi

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  echo "Kind cluster '$CLUSTER_NAME' already exists." >&2
  echo "Delete it first if you need different port bindings:" >&2
  echo "  ./scripts/create-local-kind.sh --name $CLUSTER_NAME --delete" >&2
  exit 1
fi

cat <<EOF
Creating kind cluster '$CLUSTER_NAME'
  host bind address: $HOST_BIND_ADDRESS
  web URL port:      $WEB_PORT
  api URL port:      $API_PORT
EOF

kind create cluster --name "$CLUSTER_NAME" --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  extraPortMappings:
  - containerPort: $WEB_PORT
    hostPort: $WEB_PORT
    listenAddress: "$HOST_BIND_ADDRESS"
    protocol: TCP
  - containerPort: $API_PORT
    hostPort: $API_PORT
    listenAddress: "$HOST_BIND_ADDRESS"
    protocol: TCP
EOF

kubectl cluster-info --context "kind-$CLUSTER_NAME" >/dev/null
kubectl wait --context "kind-$CLUSTER_NAME" --for=condition=Ready nodes --all --timeout=120s >/dev/null

echo ""
echo "Kind cluster '$CLUSTER_NAME' is ready."
echo "  kubectl config use-context kind-$CLUSTER_NAME"
echo "  published web port: $HOST_BIND_ADDRESS:$WEB_PORT"
echo "  published api port: $HOST_BIND_ADDRESS:$API_PORT"
