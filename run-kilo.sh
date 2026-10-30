#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/defaults-kilo.sh"

WORKSPACE="$(realpath -e "${KILO_WORKSPACE:-${HOME}/Projects/github.com}")"
if [[ ! -d "$WORKSPACE" ]]; then
    printf 'Workspace is not a directory: %s\n' "$WORKSPACE" >&2
    exit 1
fi
WORKDIR="$WORKSPACE"
if [[ "$PWD/" == "$WORKSPACE/"* ]]; then
    WORKDIR="$PWD"
fi
ARGS=(run --rm -i --userns=keep-id --security-opt label=disable --network=host
    --cap-drop=all --security-opt no-new-privileges
    --hostname kilo-kubevirt --env "HOME=$HOME"
    --env "KILO_CONTAINER_WORKSPACE=$WORKSPACE" --workdir "$WORKDIR")
[[ ! -t 0 || ! -t 1 ]] || ARGS+=(-t)

# Forward names, not values: supports arbitrary {env:...} config substitutions,
# including multiline JSON, without putting credentials on the command line.
# Host process metadata and executable/toolchain paths are not portable.
while IFS= read -r name; do
    case "$name" in
        HOME|PATH|SHELL|PWD|OLDPWD|SHLVL|_|USER|USERNAME|LOGNAME|HOSTNAME|TMPDIR|XDG_RUNTIME_DIR|SSH_AUTH_SOCK|SSH_AGENT_PID|GOROOT|GOPATH|GOBIN|KILO_BIN_PATH|KILO_PID|KILO_RUN_ID|KILO_PROCESS_ROLE) continue ;;
        KILO_PERMISSION|KILO_TEST_MANAGED_CONFIG_DIR|KILO_PURE|KILO_CONTAINER_WORKSPACE|KILO_DISABLE_AUTOUPDATE|BASH_ENV|ENV|NODE_OPTIONS|BUN_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH) continue ;;
    esac
    ARGS+=(--env "$name")
done < <(compgen -e)

declare -A MOUNTED=()
mount_path() {
    local path="$1" mode="${2:-ro}" target protected
    [[ -e "$path" ]] || return 0
    path="$(realpath -ms "$path")"
    for protected in /etc/kilo /usr/local/share/kilo; do
        if [[ "$path" == "$protected" || "$path" == "$protected/"* || "$protected" == "$path/"* || "$path" == / ]]; then
            printf 'Refusing mount that shadows image-owned policy: %s\n' "$path" >&2
            exit 1
        fi
    done
    [[ -z "${MOUNTED[$path]:-}" ]] || return 0
    ARGS+=(-v "$path:$path:$mode")
    MOUNTED[$path]=1
    # Keep absolute and relative symlinks in config/skills usable.
    if [[ -L "$path" ]]; then
        target="$(realpath -e "$path")"
        mount_path "$target" "$mode"
    fi
}

declare -A SCANNED=()
mount_settings() {
    local path="$1" target link
    [[ -e "$path" ]] || return 0
    mount_path "$path" rw
    target="$(realpath -e "$path")"
    [[ -z "${SCANNED[$target]:-}" ]] || return 0
    SCANNED[$target]=1
    [[ -d "$path" ]] || return 0
    while IFS= read -r -d '' link; do
        [[ ! -e "$link" ]] || mount_settings "$(realpath -e "$link")"
    done < <(find -H "$path" \( -name node_modules -o -name .git \) -prune -o -type l -print0)
}

mount_path "$WORKSPACE" rw
# Keep current settings, plugins, credentials, history, and TUI state. These
# mounts intentionally share host state; use the same CLI version on both sides.
for path in \
    "${XDG_CONFIG_HOME:-$HOME/.config}/kilo" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/kilo" \
    "${XDG_STATE_HOME:-$HOME/.local/state}/kilo" \
    "${XDG_CACHE_HOME:-$HOME/.cache}/kilo"; do
    mkdir -p "$path"
    mount_settings "$path"
done
for path in "$HOME/.kilo" "$HOME/.claude" "$HOME/.agents" "${KILO_CONFIG_DIR:-}"; do
    mount_settings "$path"
done
for path in "$HOME/.gitconfig" "${XDG_CONFIG_HOME:-$HOME/.config}/git" \
    "$HOME/.ssh/known_hosts" "${CLOUDSDK_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/gcloud}" \
    "$HOME/.aws" "$HOME/.kube"; do
    mount_path "$path"
done
for name in KILO_CONFIG KILO_TUI_CONFIG GOOGLE_APPLICATION_CREDENTIALS \
    AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE SSL_CERT_FILE NODE_EXTRA_CA_CERTS; do
    [[ -z "${!name:-}" ]] || mount_path "${!name}"
done
IFS=: read -r -a KUBE_PATHS <<< "${KUBECONFIG:-}"
for path in "${KUBE_PATHS[@]}"; do
    [[ -z "$path" ]] || mount_path "$path"
done

if [[ -n "${SSH_AUTH_SOCK:-}" && -S "$SSH_AUTH_SOCK" ]]; then
    ARGS+=(-v "$SSH_AUTH_SOCK:/tmp/kilo-ssh-agent.sock"
        --env SSH_AUTH_SOCK=/tmp/kilo-ssh-agent.sock)
fi
if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]] && command -v gh >/dev/null; then
    GH_TOKEN="$(gh auth token 2>/dev/null || true)"
    export GH_TOKEN
    [[ -z "$GH_TOKEN" ]] || ARGS+=(--env GH_TOKEN)
fi
if [[ -d "$WORKSPACE/kubevirt.io/secrets" ]]; then
    ARGS+=(--mount "type=tmpfs,destination=$WORKSPACE/kubevirt.io/secrets")
fi
ARGS+=(-v "kilo-go-module-cache:$HOME/go")
exec podman "${ARGS[@]}" "$KILO_IMAGE" "$@"
