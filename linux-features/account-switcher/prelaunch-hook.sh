#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT:-isolated}" == "shared-local" ]] || exit 0

profile_home="${CODEX_HOME:-${HOME:-}/.codex}"
context_id="${CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID:-default}"
if [[ ! "$context_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    printf 'account-switcher: refusing invalid shared context id: %s\n' "$context_id" >&2
    exit 1
fi

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
shared_root="$data_home/codex-desktop/account-contexts/$context_id"
umask 077
mkdir -p "$profile_home/sqlite" "$shared_root"

link_catalog() {
    local target="$1" shared="$2"
    if [[ -L "$target" ]]; then
        [[ "$(readlink "$target")" == "$shared" ]] || {
            printf 'account-switcher: refusing to replace a different SQLite link: %s\n' "$target" >&2
            exit 1
        }
    elif [[ -e "$target" ]]; then
        if [[ -e "$shared" ]]; then
            backup="$target.isolated-backup"
            [[ -e "$backup" || -L "$backup" ]] && backup="$backup.$$"
            mv -- "$target" "$backup"
            ln -s -- "$shared" "$target"
        else
            mv -- "$target" "$shared"
            ln -s -- "$shared" "$target"
        fi
    elif [[ -e "$shared" ]]; then
        ln -s -- "$shared" "$target"
    fi
}

for catalog_name in codex.db codex-dev.db codex-thread-summaries.db codex-thread-summaries-dev.db; do
    link_catalog "$profile_home/sqlite/$catalog_name" "$shared_root/$catalog_name"
    for suffix in -wal -shm; do
        link_catalog "$profile_home/sqlite/$catalog_name$suffix" "$shared_root/$catalog_name$suffix"
    done
done
for suffix in "" .bak; do
    link_catalog "$profile_home/.codex-global-state.json$suffix" "$shared_root/codex-global-state.json$suffix"
done
