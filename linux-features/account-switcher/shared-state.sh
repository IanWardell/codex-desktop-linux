#!/usr/bin/env bash
set -Eeuo pipefail

ACCOUNT_SWITCHER_ID_RE='^[a-z0-9][a-z0-9._-]{0,63}$'
ACCOUNT_SWITCHER_CATALOGS=(codex.db codex-dev.db codex-thread-summaries.db codex-thread-summaries-dev.db)

account_switcher_validate_id() {
    [[ "${1:-}" =~ $ACCOUNT_SWITCHER_ID_RE ]]
}

account_switcher_profile_home() {
    local id="$1" data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    account_switcher_validate_id "$id" || return 1
    printf '%s\n' "$data_home/codex-desktop/account-profiles/$id/codex"
}

account_switcher_profile_root() {
    local id="$1" data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    account_switcher_validate_id "$id" || return 1
    [[ "$id" != default ]] || return 1
    printf '%s\n' "$data_home/codex-desktop/account-profiles/$id"
}

account_switcher_shared_root() {
    local context_id="$1" data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    account_switcher_validate_id "$context_id" || return 1
    printf '%s\n' "$data_home/codex-desktop/account-contexts/$context_id"
}

account_switcher_profile_owns_process() {
    local user_data_dir="$1" cmdline argument
    for cmdline in /proc/[0-9]*/cmdline; do
        [[ -r "$cmdline" ]] || continue
        while IFS= read -r -d '' argument; do
            [[ "$argument" == "--user-data-dir=$user_data_dir" ]] && return 0
        done < "$cmdline"
    done
    return 1
}

account_switcher_path_has_open_fd() {
    local target="$1" fd link
    [[ -e "$target" || -L "$target" ]] || return 1
    target="$(readlink -f -- "$target")" || return 1
    if command -v lsof >/dev/null 2>&1; then
        lsof -t -- "$target" 2>/dev/null | grep -q . && return 0
        return 1
    fi
    for fd in /proc/[0-9]*/fd/*; do
        link="$(readlink -f -- "$fd" 2>/dev/null || true)"
        [[ "$link" == "$target" ]] && return 0
    done
    return 1
}

account_switcher_tree_has_open_fd() {
    local target="$1" fd link
    [[ -e "$target" || -L "$target" ]] || return 1
    target="$(readlink -f -- "$target")" || return 1
    if command -v lsof >/dev/null 2>&1; then
        lsof -t +D "$target" 2>/dev/null | grep -q . && return 0
        return 1
    fi
    for fd in /proc/[0-9]*/fd/*; do
        link="$(readlink -f -- "$fd" 2>/dev/null || true)"
        [[ "$link" == "$target" || "$link" == "$target/"* ]] && return 0
    done
    return 1
}

account_switcher_delete_profile() {
    local id="$1" root codex_home user_data_dir
    root="$(account_switcher_profile_root "$id")" || {
        printf 'account-switcher: refusing to delete invalid or default profile: %s\n' "$id" >&2
        return 1
    }
    codex_home="$root/codex"
    user_data_dir="$root/electron"
    account_switcher_assert_offline "$codex_home" "$user_data_dir" || return 1
    if account_switcher_tree_has_open_fd "$root"; then
        printf 'account-switcher: refusing to delete profile with open files: %s\n' "$root" >&2
        return 1
    fi
    rm -rf -- "$root"
}

account_switcher_assert_offline() {
    local codex_home="$1" user_data_dir="${2:-}" name suffix
    [[ -z "$user_data_dir" ]] || ! account_switcher_profile_owns_process "$user_data_dir" || {
        printf 'account-switcher: profile is still owned by a live Electron process: %s\n' "$user_data_dir" >&2
        return 1
    }
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        for suffix in "" -wal -shm; do
            if account_switcher_path_has_open_fd "$codex_home/sqlite/$name$suffix"; then
                printf 'account-switcher: refusing migration while SQLite path is open: %s\n' "$codex_home/sqlite/$name$suffix" >&2
                return 1
            fi
        done
    done
}

account_switcher_restore_journal() {
    local journal="$1" record target shared backup action
    [[ -d "$journal" ]] || return 0
    if [[ -f "$journal/committed" ]]; then
        rm -rf -- "$journal"
        return 0
    fi
    while IFS= read -r -d '' record; do
        IFS=$'\t' read -r target shared backup action < "$record"
        case "$action" in
            backup)
                [[ -L "$target" ]] && unlink -- "$target"
                [[ -e "$backup" || -L "$backup" ]] && mv -- "$backup" "$target"
                ;;
            move)
                [[ -L "$target" ]] && unlink -- "$target"
                [[ -e "$shared" || -L "$shared" ]] && mv -- "$shared" "$target"
                ;;
            link) [[ -L "$target" ]] && unlink -- "$target" ;;
        esac
    done < <(find "$journal" -maxdepth 1 -type f -name '[0-9]*' -print0 | sort -rz)
    rm -rf -- "$journal"
}

account_switcher_recover_context() {
    local shared_root="$1" journal
    [[ -d "$shared_root" ]] || return 0
    while IFS= read -r -d '' journal; do
        account_switcher_restore_journal "$journal"
    done < <(find "$shared_root" -maxdepth 1 -type d -name '.account-switcher-migration-*' -print0)
}

account_switcher_link_catalog() {
    local target="$1" shared="$2" journal="$3" index="$4" backup action link_root
    mkdir -p -- "$(dirname "$target")" "$(dirname "$shared")"
    if [[ -L "$target" ]]; then
        link_root="$(readlink -f -- "$target")"
        [[ "$link_root" == "$shared" ]] && return 0
        case "$link_root" in
            "$(dirname "$shared")"/*) unlink -- "$target" ;;
            *) printf 'account-switcher: refusing unmanaged catalog symlink: %s\n' "$target" >&2; return 1 ;;
        esac
    elif [[ -e "$target" ]]; then
        backup="$target.isolated-backup"
        [[ -e "$backup" || -L "$backup" ]] && backup="$backup.$$.${index}"
        if [[ -e "$shared" || -L "$shared" ]]; then
            action=backup
            printf '%s\t%s\t%s\t%s\n' "$target" "$shared" "$backup" "$action" > "$journal/$index"
            sync -d "$journal/$index" 2>/dev/null || true
            mv -- "$target" "$backup"
        else
            action=move
            printf '%s\t%s\t%s\t%s\n' "$target" "$shared" "$backup" "$action" > "$journal/$index"
            sync -d "$journal/$index" 2>/dev/null || true
            mv -- "$target" "$shared"
        fi
    else
        action=link
        printf '%s\t%s\t%s\t%s\n' "$target" "$shared" "" "$action" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
    fi
    [[ -e "$shared" || -L "$shared" ]] || return 0
    ln -s -- "$shared" "$target"
}

account_switcher_migrate_shared() {
    local source_home="$1" target_home="$2" context_id="$3" shared_root journal index name suffix
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    account_switcher_assert_offline "$source_home" || return 1
    [[ "$target_home" == "$source_home" ]] || account_switcher_assert_offline "$target_home" || return 1
    mkdir -p -- "$shared_root"
    account_switcher_recover_context "$shared_root"
    journal="$shared_root/.account-switcher-migration-$$-$RANDOM"
    mkdir -m 0700 -- "$journal"
    index=0
    if [[ "$source_home" != "$target_home" ]]; then
        for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
            for suffix in "" -wal -shm; do
                index=$((index + 1)); account_switcher_link_catalog "$source_home/sqlite/$name$suffix" "$shared_root/$name$suffix" "$journal" "$index"
            done
        done
    fi
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        for suffix in "" -wal -shm; do
            index=$((index + 1)); account_switcher_link_catalog "$target_home/sqlite/$name$suffix" "$shared_root/$name$suffix" "$journal" "$index"
        done
    done
    touch "$journal/committed"
    sync -d "$journal/committed" 2>/dev/null || true
    rm -rf -- "$journal"
}

account_switcher_detach_isolated() {
    local codex_home="$1" context_id="$2" shared_root name suffix target shared backup
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    account_switcher_assert_offline "$codex_home" || return 1
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        for suffix in "" -wal -shm; do
            target="$codex_home/sqlite/$name$suffix"; shared="$shared_root/$name$suffix"; backup="$target.isolated-backup"
            if [[ -L "$target" ]] && [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]]; then
                unlink -- "$target"
                [[ -e "$backup" || -L "$backup" ]] && mv -- "$backup" "$target"
            fi
        done
    done
}
