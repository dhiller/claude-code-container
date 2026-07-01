#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/defaults.sh"

echo "Building ${FULL_IMAGE_PATH}..."

podman build \
    --tag "${FULL_IMAGE_PATH}" \
    --build-arg "GO_VERSION=${GIMME_GO_VERSION}" \
    --build-arg USER_UID="$(id -u)" \
    --build-arg USER_GID="$(id -g)" \
    -f "${SCRIPT_DIR}/Containerfile" \
    "${SCRIPT_DIR}"

echo ""
echo "Build complete."
podman images "${FULL_IMAGE_PATH}" --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}'
echo ""
echo "Run with:"
echo "  export CLAUDE_GCP_PROJECT_ID=itpc-gcp-hcm-pe-eng-claude"
echo "  export CLAUDE_CODE_USE_VERTEX=1"
echo "  export CLOUD_ML_REGION=global"
echo "  export ANTHROPIC_VERTEX_PROJECT_ID=\$CLAUDE_GCP_PROJECT_ID"
echo "  ${SCRIPT_DIR}/run-claude.sh"
