#!/usr/bin/env bash
# packages/app-web/scripts/nfx-lib.sh: the nfx web player library tar that nfx-web.lock pins
# (ADR 0022 item 2), fetched, built and checked.
#
#   nfx-lib.sh build [--out DIR]      fetch the source the lock names (refused unless its sha256 is
#                                     the lock's), build the tar with nfx's web/player/lib-tar.sh,
#                                     and refuse it unless its sha256 is the lock's; the tar lands in
#                                     DIR (default packages/app-web/.cache/nfx) and its path is the
#                                     last line printed, as NFX_WEB_LIB_TAR=<path>
#   nfx-lib.sh pin <commit> [--out DIR]
#                                     the same for another nfx commit, checking nothing against the
#                                     lock: prints the `nfx` line that pins it (re-pinning)
#   nfx-lib.sh check <tar>            exit 0 only if <tar>'s sha256 is the lock's
#   nfx-lib.sh show                   print the lock's pins as shell assignments (NFX_COMMIT=…)
#
# build and pin need the lock's tools on PATH (rustc with wasm32-unknown-unknown, wasm-pack,
# wasm-bindgen; lib-tar.sh checks them), Node 22 with npm, curl, GNU tar and sha256sum. They run
# nothing from the source but its own npm ci (--ignore-scripts) and lib-tar.sh. The work directory
# ($NFX_LIB_WORK, default a new temporary one) is removed afterwards unless $NFX_LIB_KEEP is set.
set -euo pipefail
export LC_ALL=C TZ=UTC

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
pkg=$(cd "$here/.." && pwd -P)
lock="$pkg/nfx-web.lock"

die() { echo "nfx-lib: $*" >&2; exit 1; }
say() { echo "nfx-lib: $*" >&2; }

# The lock's pins, checked for form.
read_lock() {
    [ -f "$lock" ] || die "no $lock"
    local line
    line=$(grep -E '^nfx ' "$lock") || die "the lock has no nfx line"
    [ "$(grep -cE '^nfx ' "$lock")" = 1 ] || die "the lock has more than one nfx line"
    read -r _ NFX_COMMIT NFX_SRC_SHA256 NFX_LIB_SHA256 extra <<<"$line"
    [ -z "${extra:-}" ] || die "the nfx line has more than three fields"
    [[ $NFX_COMMIT =~ ^[0-9a-f]{40}$ ]] || die "the lock's commit is not 40 lowercase hex"
    [[ $NFX_SRC_SHA256 =~ ^[0-9a-f]{64}$ ]] || die "the lock's source sha256 is not 64 lowercase hex"
    [[ $NFX_LIB_SHA256 =~ ^[0-9a-f]{64}$ ]] || die "the lock's library sha256 is not 64 lowercase hex"
    local rust pack bindgen
    rust=$(grep -E '^tool rust ' "$lock") || die "the lock has no tool line for rust"
    pack=$(grep -E '^tool wasm-pack ' "$lock") || die "the lock has no tool line for wasm-pack"
    bindgen=$(grep -E '^tool wasm-bindgen ' "$lock") || die "the lock has no tool line for wasm-bindgen"
    read -r _ _ RUST_VERSION _ <<<"$rust"
    read -r _ _ WASM_PACK_VERSION WASM_PACK_SHA256 _ <<<"$pack"
    read -r _ _ WASM_BINDGEN_VERSION WASM_BINDGEN_SHA256 _ <<<"$bindgen"
    [[ $RUST_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the lock's rust version is malformed"
    [[ $WASM_PACK_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $WASM_PACK_SHA256 =~ ^[0-9a-f]{64}$ ]] \
        || die "the lock's wasm-pack line is malformed"
    [[ $WASM_BINDGEN_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $WASM_BINDGEN_SHA256 =~ ^[0-9a-f]{64}$ ]] \
        || die "the lock's wasm-bindgen line is malformed"
}

sha256_of() { sha256sum < "$1" | cut -d' ' -f1; }

# build_tar COMMIT SRC_SHA256 EXPECT_TAR_SHA256|"" OUT_DIR: prints the tar's sha256, leaves the tar in OUT_DIR.
build_tar() {
    local commit=$1 src_sha=$2 expect=$3 out=$4
    local work=${NFX_LIB_WORK:-}
    if [ -z "$work" ]; then
        work=$(mktemp -d)
        # Expanded now: `work` is local, and the trap runs when this subshell exits.
        # shellcheck disable=SC2064
        [ -n "${NFX_LIB_KEEP:-}" ] || trap "rm -rf '$work'" EXIT
    fi
    mkdir -p "$work" "$out"
    local url="https://github.com/SovereignTechnology/nfx/archive/${commit}.tar.gz"
    say "fetching $url"
    curl -sSfL --proto '=https' --tlsv1.2 --retry 5 --retry-all-errors --retry-delay 5 \
        -o "$work/src.tar.gz" "$url" || die "fetch failed: $url"
    local got
    got=$(sha256_of "$work/src.tar.gz")
    if [ -n "$src_sha" ] && [ "$got" != "$src_sha" ]; then
        die "the source archive's sha256 is $got, not the lock's $src_sha"
    fi
    say "source sha256 $got"
    rm -rf "$work/src" && mkdir -p "$work/src"
    tar -xzf "$work/src.tar.gz" -C "$work/src" --strip-components=1 --no-same-owner --no-same-permissions
    [ -f "$work/src/web/player/lib-tar.sh" ] || die "the source has no web/player/lib-tar.sh"
    say "npm ci --ignore-scripts (web/player's own lockfile)"
    (cd "$work/src/web/player" && npm ci --ignore-scripts --no-audit --no-fund >&2)
    say "lib-tar.sh --commit $commit"
    local args=(--commit "$commit")
    [ -z "$expect" ] || args+=(--expect "$expect")
    (cd "$work/src/web/player" && bash lib-tar.sh "${args[@]}" >&2)
    local name="nfx-web-lib-${commit:0:12}.tar"
    local tar="$work/src/web/player/out-lib/$name"
    [ -f "$tar" ] || die "lib-tar.sh left no $name"
    local sha
    sha=$(sha256_of "$tar")
    if [ -n "$expect" ] && [ "$sha" != "$expect" ]; then
        die "the library tar's sha256 is $sha, not the lock's $expect"
    fi
    install -m 0644 "$tar" "$out/$name"
    echo "$got $sha"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case $cmd in
    show)
        read_lock
        cat <<EOF
NFX_COMMIT=$NFX_COMMIT
NFX_SRC_SHA256=$NFX_SRC_SHA256
NFX_LIB_SHA256=$NFX_LIB_SHA256
RUST_VERSION=$RUST_VERSION
WASM_PACK_VERSION=$WASM_PACK_VERSION
WASM_PACK_SHA256=$WASM_PACK_SHA256
WASM_BINDGEN_VERSION=$WASM_BINDGEN_VERSION
WASM_BINDGEN_SHA256=$WASM_BINDGEN_SHA256
EOF
        ;;
    check)
        [ $# = 1 ] || die "usage: nfx-lib.sh check <tar>"
        read_lock
        [ -f "$1" ] || die "no such file: $1"
        got=$(sha256_of "$1")
        [ "$got" = "$NFX_LIB_SHA256" ] || die "$1: sha256 $got, not the lock's $NFX_LIB_SHA256"
        say "OK: $1 is the lock's library ($NFX_LIB_SHA256)"
        ;;
    build|pin)
        read_lock
        commit=$NFX_COMMIT src=$NFX_SRC_SHA256 expect=$NFX_LIB_SHA256
        if [ "$cmd" = pin ]; then
            [ $# -ge 1 ] || die "usage: nfx-lib.sh pin <commit> [--out DIR]"
            commit=$1 src= expect=
            shift
            [[ $commit =~ ^[0-9a-f]{40}$ ]] || die "the commit must be 40 lowercase hex"
        fi
        out="$pkg/.cache/nfx"
        while [ $# -gt 0 ]; do
            case $1 in
                --out) out=${2:?--out needs a directory}; shift 2 ;;
                *) die "unknown option: $1" ;;
            esac
        done
        # An assignment, so that a failure inside stops the script (set -e).
        result=$(build_tar "$commit" "$src" "$expect" "$out")
        read -r src_got tar_got <<<"$result"
        name="nfx-web-lib-${commit:0:12}.tar"
        if [ "$cmd" = pin ]; then
            echo "nfx $commit $src_got $tar_got"
        else
            say "OK: the library tar is the lock's ($tar_got)"
        fi
        echo "NFX_WEB_LIB_TAR=$(cd "$out" && pwd -P)/$name"
        ;;
    *)
        sed -n '2,20p' "$0" >&2
        exit 2
        ;;
esac
