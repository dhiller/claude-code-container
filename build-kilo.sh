#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/defaults-kilo.sh"

# Match the host CLI by default instead of silently upgrading its shared database.
KILO_VERSION="${KILO_VERSION:-$(kilo --version)}"
exec podman build --tag "$KILO_IMAGE" \
    --build-arg "KILO_VERSION=$KILO_VERSION" \
    --build-arg "GO_VERSION=$GO_VERSION" \
    --build-arg "USER_UID=$(id -u)" \
    --build-arg "USER_GID=$(id -g)" \
    --build-arg "USER_HOME=$HOME" \
    -f "${SCRIPT_DIR}/Containerfile.kilo" "$SCRIPT_DIR" "$@"
