#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin"

# NUL records preserve empty arguments, whitespace, and multiline values.
cat > "$ROOT/bin/podman" <<'MOCK'
#!/bin/bash
set -eu
[[ "$1" != images ]] || exit 0
printf '%s\0' "$@" > "$CAPTURE/args"
env -0 > "$CAPTURE/env"
MOCK
cat > "$ROOT/bin/gh" <<'MOCK'
#!/bin/bash
set -eu
printf '%s\0' "$@" > "$CAPTURE/gh"
[[ "${FAKE_GH_FAIL:-0}" == 0 ]] || exit 1
printf '%s\n' synthetic-gh-fallback
MOCK
cat > "$ROOT/bin/kilo" <<'MOCK'
#!/bin/bash
set -eu
printf '%s\0' "$@" > "$CAPTURE/kilo"
[[ "${FAKE_KILO_FAIL:-0}" == 0 ]] || exit 1
printf '%s\n' 7.8.9
MOCK
chmod +x "$ROOT/bin/"*

fail() { printf 'FAIL: %s: %s\n' "$CASE" "$1" >&2; exit 1; }
fixture() {
    CASE="$1"
    H="$ROOT/$CASE/home"
    W="$H/Projects/github.com"
    C="$ROOT/$CASE/capture"
    mkdir -p "$W/nested dir" "$C"
    BASE=(env -i "HOME=$H" "PATH=$ROOT/bin:/usr/bin:/bin" "CAPTURE=$C")
    EXTRA=()
}
launch() {
    (cd "$W/nested dir"; "${BASE[@]}" "${EXTRA[@]}" timeout 10s /bin/bash "$SCRIPT_DIR/run-kilo.sh" "$@")
    mapfile -d '' -t ARGS < "$C/args"
    mapfile -d '' -t ENVS < "$C/env"
}
# Match adjacent option/value records, not substrings of a flattened command.
count_pair() {
    local i
    COUNT=0
    for ((i=0; i+1<${#ARGS[@]}; i++)); do
        if [[ "${ARGS[i]}" == "$1" && "${ARGS[i+1]}" == "$2" ]]; then
            COUNT=$((COUNT + 1))
        fi
    done
}
pair() { count_pair "$1" "$2"; [[ "$COUNT" == 1 ]] || fail "expected one $1 record ($3)"; }
no_pair() { count_pair "$1" "$2"; [[ "$COUNT" == 0 ]] || fail "unexpected $1 record ($3)"; }
env_value() {
    local item
    for item in "${ENVS[@]}"; do
        [[ "$item" != "$1=$2" ]] || return 0
    done
    fail "environment value not preserved for $1"
}
mount() { pair -v "$1:$1:${2:-ro}" 'mount'; }

fixture forwarding
MULTILINE=$'{\n  "provider": "synthetic",\n  "note": "two words"\n}'
EXTRA=("CUSTOM_ARBITRARY_PROVIDER=synthetic-provider" "KILO_CONFIG_CONTENT=$MULTILINE"
    'GH_TOKEN=synthetic-existing' 'TERM=xterm-test' 'GIMME_GO_VERSION=1.2.3')
EXCLUDED=(SHELL OLDPWD USER USERNAME LOGNAME HOSTNAME TMPDIR XDG_RUNTIME_DIR
    SSH_AUTH_SOCK SSH_AGENT_PID GOROOT GOPATH GOBIN KILO_BIN_PATH KILO_PID KILO_RUN_ID KILO_PROCESS_ROLE
    KILO_PERMISSION KILO_TEST_MANAGED_CONFIG_DIR KILO_PURE KILO_CONTAINER_WORKSPACE KILO_DISABLE_AUTOUPDATE
    BASH_ENV ENV NODE_OPTIONS BUN_OPTIONS LD_PRELOAD LD_LIBRARY_PATH)
for name in "${EXCLUDED[@]}"; do
    case "$name" in
        BASH_ENV|ENV|NODE_OPTIONS|BUN_OPTIONS|LD_PRELOAD) EXTRA+=("$name=") ;;
        *) EXTRA+=("$name=synthetic-excluded") ;;
    esac
done
launch 'argument with spaces' '' $'line one\nline two' '--flag=value with spaces' '*'
for name in CUSTOM_ARBITRARY_PROVIDER KILO_CONFIG_CONTENT GH_TOKEN TERM GIMME_GO_VERSION; do
    pair --env "$name" "forwarded name $name"
done
env_value CUSTOM_ARBITRARY_PROVIDER synthetic-provider
env_value KILO_CONFIG_CONTENT "$MULTILINE"
env_value GH_TOKEN synthetic-existing
for name in HOME PATH PWD SHLVL _ "${EXCLUDED[@]}"; do
    no_pair --env "$name" "excluded name $name"
done
for ((i=0; i<${#ARGS[@]}; i++)); do
    if [[ "${ARGS[i]}" == --env ]]; then
        [[ "${ARGS[i+1]}" != *=* || "${ARGS[i+1]}" == "HOME=$H" || "${ARGS[i+1]}" == "KILO_CONTAINER_WORKSPACE=$W" ]] || fail 'value exposed in --env'
    fi
done
pair --env "HOME=$H" 'container home'
pair --env "KILO_CONTAINER_WORKSPACE=$W" 'trusted workspace for security policy'
pair --security-opt no-new-privileges 'privilege escalation disabled'
[[ " ${ARGS[*]} " == *' --cap-drop=all '* ]] || fail 'capabilities not dropped'
no_pair -v /etc/kilo:/etc/kilo:ro 'host policy must not shadow image policy'
pair --workdir "$W/nested dir" 'nested cwd'
mount "$W" rw
for path in .config/kilo .local/share/kilo .local/state/kilo .cache/kilo; do
    [[ -d "$H/$path" ]] || fail 'default state directory not created'
    mount "$H/$path" rw
done
pair -v "kilo-go-module-cache:$H/go" 'module cache'
EXPECTED=(quay.io/dhiller/kilo-code-kubevirt:latest 'argument with spaces' '' $'line one\nline two' '--flag=value with spaces' '*')
START=$((${#ARGS[@]} - ${#EXPECTED[@]}))
for i in "${!EXPECTED[@]}"; do
    [[ "${ARGS[START+i]}" == "${EXPECTED[i]}" ]] || fail 'image/argument boundaries changed'
done
[[ ! -e "$C/gh" ]] || fail 'gh called despite GH_TOKEN'

fixture mounts
X="$ROOT/$CASE/xdg space"
W="$ROOT/$CASE/workspace space"
mkdir -p "$X" "$H/.kilo" "$H/.ssh" "$H/.aws" "$H/.kube" "$H/skills" "$W/kubevirt.io/secrets"
mkdir -p "$W/nested dir" "$X/config/git" "$X/config/gcloud"
touch "$H/.gitconfig" "$H/.ssh/known_hosts" "$X/config.json" "$X/kube one" "$X/kube two"
ln -s skills "$H/.agents"
ln -s "$H/skills" "$H/.claude"
ln -s 'kube one' "$X/kube link"
EXTRA=("KILO_WORKSPACE=$W" "XDG_CONFIG_HOME=$X/config" "XDG_DATA_HOME=$X/data"
    "XDG_STATE_HOME=$X/state" "XDG_CACHE_HOME=$X/cache" "KILO_CONFIG=$X/config.json"
    "KILO_CONFIG_DIR=$H/.kilo" "KILO_TUI_CONFIG=$X/absent"
    "KUBECONFIG=$X/kube one::$X/kube two:$X/missing:$X/kube link:$X/kube one:"
    'KILO_IMAGE=synthetic-image:test')
launch
for path in config data state cache; do
    [[ -d "$X/$path/kilo" ]] || fail 'XDG directory not created'
    mount "$X/$path/kilo" rw
done
for path in .config/kilo .local/share/kilo .local/state/kilo .cache/kilo; do
    no_pair -v "$H/$path:$H/$path:rw" 'default path with XDG override'
done
mount "$W" rw
pair --workdir "$W/nested dir" 'custom workspace cwd'
for path in "$H/.kilo" "$H/.agents" "$H/.claude" "$H/skills"; do mount "$path" rw; done
for path in "$H/.gitconfig" "$H/.ssh/known_hosts" "$H/.aws" "$H/.kube" \
    "$X/config/git" "$X/config/gcloud" "$X/config.json" "$X/kube one" "$X/kube two" "$X/kube link"; do mount "$path"; done
no_pair -v "$H/.kilo:$H/.kilo:ro" 'duplicate config directory'
for path in "$X/absent" "$X/missing"; do no_pair -v "$path:$path:ro" 'optional missing file'; done
pair --mount "type=tmpfs,destination=$W/kubevirt.io/secrets" 'secrets masking'
[[ "${ARGS[${#ARGS[@]}-1]}" == synthetic-image:test ]] || fail 'image override ignored'

fixture settings-links
S="$ROOT/$CASE/custom settings"
T="$ROOT/$CASE/external skills"
CONFIG="$H/.config/kilo"
mkdir -p "$CONFIG" "$S" "$T/default" "$T/custom" "$T/deep"
ln -s "$T/default" "$CONFIG/skills"
ln -s "$T/custom" "$S/skills"
ln -s ../deep "$T/default/nested"
ln -s ../deep "$T/custom/nested"
# Both settings roots recur through the external targets; each mounts only once.
ln -s "$CONFIG" "$T/deep/default-cycle"
ln -s "$S" "$T/deep/custom-cycle"
ln -s absent "$CONFIG/broken"
ln -s absent "$S/broken"
for name in node_modules .git; do
    mkdir -p "$S/$name" "$T/skipped-$name"
    ln -s "$T/skipped-$name" "$S/$name/ignored"
done
EXTRA=("KILO_CONFIG_DIR=$S")
launch
pair --env KILO_CONFIG_DIR 'custom settings directory name'
for path in "$S" "$CONFIG" "$T/default" "$T/custom" "$T/deep"; do
    mount "$path" rw
    no_pair -v "$path:$path:ro" 'settings must remain writable'
done
for path in "$T/skipped-node_modules" "$T/skipped-.git" "$CONFIG/broken" "$S/broken"; do
    no_pair -v "$path:$path:rw" 'pruned or broken settings link'
    no_pair -v "$path:$path:ro" 'pruned or broken settings link'
done

fixture optional
EXTRA=("KILO_CONFIG=$H/missing.json" "KILO_CONFIG_DIR=$H/missing-dir" 'FAKE_GH_FAIL=1')
launch
for path in "$H/missing.json" "$H/missing-dir" "$H/.gitconfig" "$H/.ssh/known_hosts" "$H/.aws" "$H/.kube"; do
    no_pair -v "$path:$path:ro" 'missing optional mount'
done
for path in .kilo .claude .agents; do no_pair -v "$H/$path:$H/$path:rw" 'missing optional state'; done
no_pair -v "$H/missing-dir:$H/missing-dir:rw" 'missing optional custom settings'
no_pair --env GH_TOKEN 'failed gh fallback'
[[ -f "$C/gh" ]] || fail 'gh fallback not attempted'

fixture fallback
launch
pair --env GH_TOKEN 'gh fallback by name'
env_value GH_TOKEN synthetic-gh-fallback
mapfile -d '' -t CALL < "$C/gh"
[[ "${#CALL[@]}" == 2 && "${CALL[0]}" == auth && "${CALL[1]}" == token ]] || fail 'unexpected gh invocation'

for mode in github both; do
    fixture "$mode"
    EXTRA=('GITHUB_TOKEN=synthetic-github')
    [[ "$mode" != both ]] || EXTRA+=('GH_TOKEN=synthetic-gh')
    launch
    [[ ! -e "$C/gh" ]] || fail 'existing token did not suppress gh fallback'
    pair --env GITHUB_TOKEN 'existing GitHub token'
    env_value GITHUB_TOKEN synthetic-github
    if [[ "$mode" == both ]]; then
        pair --env GH_TOKEN 'existing GH token'
        env_value GH_TOKEN synthetic-gh
    else
        no_pair --env GH_TOKEN 'unwanted GH token'
    fi
done

fixture outside
(cd "$H"; "${BASE[@]}" /bin/bash "$SCRIPT_DIR/run-kilo.sh")
mapfile -d '' -t ARGS < "$C/args"
pair --workdir "$W" 'cwd outside workspace'
for kind in missing file; do
    fixture "invalid-$kind"
    BAD="$H/$kind"
    [[ "$kind" != file ]] || touch "$BAD"
    if "${BASE[@]}" "KILO_WORKSPACE=$BAD" /bin/bash "$SCRIPT_DIR/run-kilo.sh" > "$C/output" 2>&1; then
        fail 'invalid workspace accepted'
    fi
    [[ ! -e "$C/args" && ! -e "$C/gh" ]] || fail 'invalid workspace reached external commands'
done

for path in /etc /usr/local/share /; do
    fixture protected-mount
    if "${BASE[@]}" "KILO_WORKSPACE=$path" /bin/bash "$SCRIPT_DIR/run-kilo.sh" > "$C/output" 2>&1; then
        fail 'policy-shadowing workspace accepted'
    fi
    [[ ! -e "$C/args" ]] || fail 'protected mount reached podman'
done

for mode in host override; do
    fixture "build-$mode"
    EXTRA=('GIMME_GO_VERSION=1.25.0')
    VERSION=7.8.9
    if [[ "$mode" == override ]]; then
        VERSION=4.5.6
        EXTRA+=('KILO_VERSION=4.5.6' 'FAKE_KILO_FAIL=1' 'GO_VERSION=1.27.4' 'KILO_IMAGE=synthetic-build:test')
    fi
    "${BASE[@]}" "${EXTRA[@]}" /bin/bash "$SCRIPT_DIR/build-kilo.sh" --label 'test=two words' ''
    mapfile -d '' -t ARGS < "$C/args"
    mapfile -d '' -t ENVS < "$C/env"
    [[ "${ARGS[0]}" == build ]] || fail 'not a container build'
    pair --build-arg "KILO_VERSION=$VERSION" 'pinned CLI version'
    pair --build-arg "USER_HOME=$H" 'host home'
    pair --build-arg "USER_UID=$(id -u)" 'host uid'
    pair --build-arg "USER_GID=$(id -g)" 'host gid'
    pair -f "$SCRIPT_DIR/Containerfile.kilo" 'containerfile'
    pair --label 'test=two words' 'build argument boundaries'
    [[ "${ARGS[${#ARGS[@]}-1]}" == '' && "${ARGS[${#ARGS[@]}-4]}" == "$SCRIPT_DIR" ]] || fail 'build context/empty argument changed'
    if [[ "$mode" == host ]]; then
        pair --tag quay.io/dhiller/kilo-code-kubevirt:latest 'default image'
        pair --build-arg GO_VERSION=1.27.3 'default Go version independent of host toolchain'
        env_value GO_VERSION 1.27.3
        mapfile -d '' -t CALL < "$C/kilo"
        [[ "${#CALL[@]}" == 1 && "${CALL[0]}" == --version ]] || fail 'host version not queried'
    else
        pair --tag synthetic-build:test 'image override'
        pair --build-arg GO_VERSION=1.27.4 'Go version override'
        env_value GO_VERSION 1.27.4
        [[ ! -e "$C/kilo" ]] || fail 'explicit version queried host CLI'
    fi
done
for mode in default override; do
    fixture "claude-build-$mode"
    EXTRA=('GIMME_GO_VERSION=1.25.0')
    VERSION=1.27.3
    if [[ "$mode" == override ]]; then
        VERSION=1.27.4
        EXTRA+=("GO_VERSION=$VERSION")
    fi
    "${BASE[@]}" "${EXTRA[@]}" /bin/bash "$SCRIPT_DIR/build.sh" > "$C/output"
    mapfile -d '' -t ARGS < "$C/args"
    mapfile -d '' -t ENVS < "$C/env"
    pair --build-arg "GO_VERSION=$VERSION" 'shared Claude Go version'
    env_value GO_VERSION "$VERSION"
done
CASE=containerfile
for file in Containerfile Containerfile.kilo; do
    # shellcheck disable=SC2016
    grep -Fxq 'FROM docker.io/library/golang:${GO_VERSION}-bookworm AS go-tools' "$SCRIPT_DIR/$file" || fail 'tools image not using shared Go version'
    [[ "$(grep -c '^ARG GO_VERSION$' "$SCRIPT_DIR/$file")" == 2 ]] || fail 'Go version must be declared globally and in runtime stage'
done
grep -Fxq 'ARG KILO_VERSION' "$SCRIPT_DIR/Containerfile.kilo" || fail 'CLI version must be supplied by build'
# Match the Containerfile's literal variable reference, not the test environment.
# shellcheck disable=SC2016
grep -Fq 'npm install -g "@kilocode/cli@${KILO_VERSION}"' "$SCRIPT_DIR/Containerfile.kilo" || fail 'CLI installation not pinned'
printf 'PASS: launcher forwarding, mounts, workspace, credentials, arguments, and build pinning\n'
