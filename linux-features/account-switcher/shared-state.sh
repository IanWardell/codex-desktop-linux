#!/usr/bin/env bash
set -Eeuo pipefail

ACCOUNT_SWITCHER_ID_RE='^[a-z0-9][a-z0-9._-]{0,63}$'
ACCOUNT_SWITCHER_CATALOGS=(codex.db codex-dev.db codex-thread-summaries.db codex-thread-summaries-dev.db)
ACCOUNT_SWITCHER_SESSION_PATHS=(sessions session_index.jsonl)

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

account_switcher_context_lock_acquire() {
    local shared_root="$1" lock="$1/.account-switcher.lock" deadline owner
    mkdir -p -- "$shared_root"
    deadline=$((SECONDS + 5))
    while ! mkdir -m 0700 -- "$lock" 2>/dev/null; do
        if [[ -r "$lock/pid" ]]; then
            IFS= read -r owner < "$lock/pid" || true
            if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
                rm -rf -- "$lock"
                continue
            fi
        fi
        if (( SECONDS >= deadline )); then
            printf 'account-switcher: shared context is busy: %s\n' "$shared_root" >&2
            return 1
        fi
        sleep 0.05
    done
    printf '%s\n' "$$" > "$lock/pid"
    printf '%s\n' "$lock"
}

account_switcher_context_lock_release() {
    local lock="$1" owner=""
    [[ -d "$lock" ]] || return 0
    IFS= read -r owner < "$lock/pid" || true
    [[ "$owner" == "$$" ]] || {
        printf 'account-switcher: refusing to release another process lock: %s\n' "$lock" >&2
        return 1
    }
    rm -rf -- "$lock"
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
    local codex_home="$1" user_data_dir="${2:-}" name suffix relative
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
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        if [[ -d "$codex_home/$relative" ]]; then
            account_switcher_tree_has_open_fd "$codex_home/$relative" && {
                printf 'account-switcher: refusing migration while session path is open: %s\n' "$codex_home/$relative" >&2
                return 1
            }
        elif account_switcher_path_has_open_fd "$codex_home/$relative"; then
            printf 'account-switcher: refusing migration while session path is open: %s\n' "$codex_home/$relative" >&2
            return 1
        fi
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
            detach)
                if [[ -e "$target" && ! -L "$target" && ! -e "$backup" && ! -L "$backup" ]]; then
                    mv -- "$target" "$backup"
                else
                    [[ -L "$target" ]] && unlink -- "$target"
                fi
                [[ -e "$shared" || -L "$shared" ]] && ln -s -- "$shared" "$target"
                ;;
            restore)
                [[ -e "$target" || -L "$target" ]] && rm -f -- "$target"
                [[ -e "$backup" || -L "$backup" ]] && mv -- "$backup" "$target"
                ;;
            session-move)
                [[ -e "$shared" || -L "$shared" ]] && {
                    mkdir -p -- "$(dirname -- "$target")"
                    mv -- "$shared" "$target"
                }
                ;;
            session-link)
                [[ -e "$target" || -L "$target" ]] && rm -f -- "$target"
                ;;
            session-dir)
                [[ -d "$target" && ! -L "$target" ]] && rmdir -- "$target" 2>/dev/null || true
                ;;
        esac
    done < <(find "$journal" -maxdepth 1 -type f -name '[0-9]*' -print0 | sort -zrn)
    rm -rf -- "$journal"
}

account_switcher_node_binary() {
    local node="${CODEX_LINUX_APP_DIR:-}/resources/cua_node/bin/node"
    if [[ -x "$node" ]]; then
        printf '%s\n' "$node"
    else
        command -v node
    fi
}

account_switcher_backup_file() {
    local target="$1" journal="$2" index="$3" backup="$journal/state-$index.backup"
    printf '%s\t\t%s\trestore\n' "$target" "$backup" > "$journal/$index"
    sync -d "$journal/$index" 2>/dev/null || true
    if [[ -e "$target" || -L "$target" ]]; then
        mv -- "$target" "$backup"
    fi
}

account_switcher_prepare_local_state() {
    local source_home="$1" target_home="$2" shared_root="$3" journal="$4" index="$5"
    local source_state="$source_home/.codex-global-state.json"
    local target_state="$target_home/.codex-global-state.json"
    local shared_state="$shared_root/local-project-state.json"
    local source_snapshot="$journal/source-global-state.json"
    local helper node

    # The default profile is both source and target during its first shared
    # launch. Snapshot before backing up the target so the source remains
    # readable to the JSON merger while the transaction is prepared.
    if [[ "$source_state" == "$target_state" && -f "$source_state" ]]; then
        cp -- "$source_state" "$source_snapshot"
        source_state="$source_snapshot"
    fi
    account_switcher_backup_file "$target_state" "$journal" "$index"
    if [[ "$source_state" == "$source_snapshot" && -f "$source_snapshot" ]]; then
        cp -- "$source_snapshot" "$target_state"
    fi
    account_switcher_backup_file "$shared_state" "$journal" "$((index + 1))"
    helper="$(dirname -- "${BASH_SOURCE[0]}")/shared-state-json.js"
    node="$(account_switcher_node_binary)"
    "$node" "$helper" prepare "$source_state" "$target_state" "$shared_state"
}

account_switcher_recover_context() {
    local shared_root="$1" journal owner
    [[ -d "$shared_root" ]] || return 0
    while IFS= read -r -d '' journal; do
        owner=""
        [[ -r "$journal/pid" ]] && IFS= read -r owner < "$journal/pid" || true
        [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null && continue
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

account_switcher_merge_session_tree() {
    local source="$1" shared="$2" journal="$3" index="$4" file relative target
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    if [[ -L "$source" ]]; then
        [[ "$(readlink -f -- "$source")" == "$(readlink -f -- "$shared")" ]] && return 0
        printf 'account-switcher: refusing unmanaged session tree symlink: %s\n' "$source" >&2
        return 1
    fi
    [[ -d "$source" ]] || return 0
    mkdir -p -- "$shared"
    [[ ! -L "$shared" ]] || {
        printf 'account-switcher: refusing unmanaged shared session tree symlink: %s\n' "$shared" >&2
        return 1
    }
    if find "$source" -type l -print -quit | grep -q .; then
        printf 'account-switcher: refusing session tree containing symlinks: %s\n' "$source" >&2
        return 1
    fi
    while IFS= read -r -d '' file; do
        relative="${file#"$source"/}"
        target="$shared/$relative"
        if [[ -e "$target" || -L "$target" ]]; then
            continue
        fi
        mkdir -p -- "$(dirname -- "$target")"
        index=$((index + 1))
        if ! ln -- "$file" "$target" 2>/dev/null; then
            cp -p -- "$file" "$target"
        fi
        printf '%s\t\t\tsession-link\n' "$target" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
    done < <(find "$source" -type f -print0)
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_merge_session_index() {
    local source="$1" shared="$2" journal="$3" index="$4" temporary backup
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    if [[ -L "$source" ]]; then
        [[ "$(readlink -f -- "$source")" == "$(readlink -f -- "$shared")" ]] && return 0
        printf 'account-switcher: refusing unmanaged session index symlink: %s\n' "$source" >&2
        return 1
    fi
    [[ -f "$source" ]] || return 0
    mkdir -p -- "$(dirname -- "$shared")"
    if [[ ! -e "$shared" ]]; then
        if ! ln -- "$source" "$shared" 2>/dev/null; then
            cp -p -- "$source" "$shared"
        fi
        index=$((index + 1))
        printf '%s\t\t\tsession-link\n' "$shared" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
        ACCOUNT_SWITCHER_MERGE_INDEX="$index"
        return 0
    fi
    [[ ! -L "$shared" ]] || {
        printf 'account-switcher: refusing unmanaged shared session index symlink: %s\n' "$shared" >&2
        return 1
    }
    index=$((index + 1))
    account_switcher_backup_file "$shared" "$journal" "$index"
    backup="$journal/state-$index.backup"
    temporary="$shared.tmp.$$.$index"
    awk 'NF && !seen[$0]++ { print }' "$backup" "$source" > "$temporary"
    mv -- "$temporary" "$shared"
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_materialize_session_tree() {
    local target="$1" shared="$2" journal="$3" index="$4" file relative destination
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -d "$shared" && ! -L "$shared" ]] || return 0
    if [[ -L "$target" ]]; then
        [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]] || {
            printf 'account-switcher: refusing unmanaged session tree symlink: %s\n' "$target" >&2
            return 1
        }
        index=$((index + 1))
        account_switcher_backup_file "$target" "$journal" "$index"
        mkdir -p -- "$target"
    elif [[ -e "$target" ]]; then
        [[ -d "$target" ]] || {
            printf 'account-switcher: refusing session path that is not a directory: %s\n' "$target" >&2
            return 1
        }
        if find "$target" -type l -print -quit | grep -q .; then
            printf 'account-switcher: refusing session tree containing symlinks: %s\n' "$target" >&2
            return 1
        fi
    else
        index=$((index + 1))
        printf '%s\t\t\tsession-dir\n' "$target" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
        mkdir -p -- "$target"
    fi
    while IFS= read -r -d '' file; do
        relative="${file#"$shared"/}"
        destination="$target/$relative"
        [[ -e "$destination" || -L "$destination" ]] && continue
        mkdir -p -- "$(dirname -- "$destination")"
        if ! ln -- "$file" "$destination" 2>/dev/null; then
            cp -p -- "$file" "$destination"
        fi
        index=$((index + 1))
        printf '%s\t\t\tsession-link\n' "$destination" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
    done < <(find "$shared" -type f -print0)
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_materialize_session_index() {
    local target="$1" shared="$2" journal="$3" index="$4" target_inode shared_inode
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -f "$shared" && ! -L "$shared" ]] || return 0
    if [[ -e "$target" || -L "$target" ]]; then
        target_inode="$(stat -c '%d:%i' -- "$target" 2>/dev/null || true)"
        shared_inode="$(stat -c '%d:%i' -- "$shared" 2>/dev/null || true)"
        [[ -n "$target_inode" && "$target_inode" == "$shared_inode" ]] && return 0
        if [[ -L "$target" ]]; then
            [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]] || {
                printf 'account-switcher: refusing unmanaged session index symlink: %s\n' "$target" >&2
                return 1
            }
        fi
        index=$((index + 1))
        account_switcher_backup_file "$target" "$journal" "$index"
    else
        mkdir -p -- "$(dirname -- "$target")"
    fi
    if ! ln -- "$shared" "$target" 2>/dev/null; then
        cp -p -- "$shared" "$target"
    fi
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_rewrite_state_rollout_paths() {
    local target_home="$1" shared_root="$2" journal="$3" index="$4" database suffix backup helper node
    helper="$(dirname -- "${BASH_SOURCE[0]}")/shared-state-sqlite.js"
    node="$(account_switcher_node_binary)"
    shopt -s nullglob
    for database in "$target_home"/state_*.sqlite; do
        [[ -f "$database" && ! -L "$database" ]] || continue
        for suffix in "" -wal -shm; do
            [[ -e "$database$suffix" || -L "$database$suffix" ]] || continue
            index=$((index + 1))
            account_switcher_backup_file "$database$suffix" "$journal" "$index"
            backup="$journal/state-$index.backup"
            cp -- "$backup" "$database$suffix"
        done
        "$node" "$helper" rewrite-rollout-paths "$target_home" "$shared_root" || return 1
    done
    shopt -u nullglob
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_detach_session_tree() {
    local target="$1" shared="$2" journal="$3" index="$4" file relative shared_file target_inode shared_inode has_shared=0 backup
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -e "$target" || -L "$target" ]] || return 0
    if [[ -L "$target" ]]; then
        [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]] || return 0
        has_shared=1
    elif [[ -d "$target" && -d "$shared" ]]; then
        while IFS= read -r -d '' file; do
            relative="${file#"$target"/}"
            shared_file="$shared/$relative"
            [[ -f "$shared_file" ]] || continue
            target_inode="$(stat -c '%d:%i' -- "$file" 2>/dev/null || true)"
            shared_inode="$(stat -c '%d:%i' -- "$shared_file" 2>/dev/null || true)"
            if [[ -n "$target_inode" && "$target_inode" == "$shared_inode" ]]; then has_shared=1; break; fi
        done < <(find "$target" -type f -print0)
    fi
    (( has_shared == 1 )) || return 0
    backup="$target.isolated-backup"
    if [[ -e "$backup" || -L "$backup" ]]; then
        index=$((index + 1))
        printf '%s\t%s\t%s\tdetach\n' "$target" "$shared" "$backup" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
        unlink -- "$target"
        mv -- "$backup" "$target"
        ACCOUNT_SWITCHER_MERGE_INDEX="$index"
        return 0
    fi
    index=$((index + 1))
    account_switcher_backup_file "$target" "$journal" "$index"
    if [[ -d "$shared" ]]; then
        cp -a -- "$shared" "$target"
    else
        mkdir -p -- "$target"
    fi
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_detach_session_index() {
    local target="$1" shared="$2" journal="$3" index="$4" target_inode shared_inode backup
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -e "$target" || -L "$target" ]] || return 0
    [[ -f "$shared" ]] || return 0
    target_inode="$(stat -c '%d:%i' -- "$target" 2>/dev/null || true)"
    shared_inode="$(stat -c '%d:%i' -- "$shared" 2>/dev/null || true)"
    if [[ -L "$target" ]]; then
        [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]] || return 0
    elif [[ "$target_inode" != "$shared_inode" ]]; then
        return 0
    fi
    backup="$target.isolated-backup"
    if [[ -e "$backup" || -L "$backup" ]]; then
        index=$((index + 1))
        printf '%s\t%s\t%s\tdetach\n' "$target" "$shared" "$backup" > "$journal/$index"
        sync -d "$journal/$index" 2>/dev/null || true
        unlink -- "$target"
        mv -- "$backup" "$target"
        ACCOUNT_SWITCHER_MERGE_INDEX="$index"
        return 0
    fi
    index=$((index + 1))
    account_switcher_backup_file "$target" "$journal" "$index"
    cp -p -- "$shared" "$target"
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_validate_journal() {
    local context_id="$1" journal="$2" shared_root
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    [[ "$(dirname -- "$journal")" == "$shared_root" && "$(basename -- "$journal")" == .account-switcher-migration-* ]]
}

account_switcher_commit_prepared() {
    local context_id="$1" journal="$2" shared_root lock
    account_switcher_validate_journal "$context_id" "$journal" || return 1
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    if [[ ! -d "$journal" ]] || ! touch "$journal/committed"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    sync -d "$journal/committed" 2>/dev/null || true
    rm -rf -- "$journal"
    account_switcher_context_lock_release "$lock"
}

account_switcher_rollback_prepared() {
    local context_id="$1" journal="$2" shared_root lock
    account_switcher_validate_journal "$context_id" "$journal" || return 1
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    account_switcher_restore_journal "$journal"
    account_switcher_context_lock_release "$lock"
}

account_switcher_prepare_shared() {
    local source_home="$1" target_home="$2" context_id="$3" shared_root lock journal index name suffix relative
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    if ! account_switcher_assert_offline "$source_home" ||
       { [[ "$target_home" != "$source_home" ]] && ! account_switcher_assert_offline "$target_home"; }; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    if ! account_switcher_recover_context "$shared_root"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    journal="$shared_root/.account-switcher-migration-$$-$RANDOM"
    if ! mkdir -m 0700 -- "$journal"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    printf '%s\n' "$$" > "$journal/pid"
    index=0
    if [[ "$source_home" != "$target_home" ]]; then
        for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
            for suffix in "" -wal -shm; do
                index=$((index + 1))
                if ! account_switcher_link_catalog "$source_home/sqlite/$name$suffix" "$shared_root/$name$suffix" "$journal" "$index"; then
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                fi
            done
        done
    fi
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        for suffix in "" -wal -shm; do
            index=$((index + 1))
            if ! account_switcher_link_catalog "$target_home/sqlite/$name$suffix" "$shared_root/$name$suffix" "$journal" "$index"; then
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            fi
        done
    done
    # Rollout files must remain lexically inside the active CODEX_HOME. Keep
    # the shared context as the merge source, but materialize active session
    # paths with hardlinks instead of symlinks. Existing files still share
    # writes; newly-created files are merged on the next handoff.
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        if [[ "$relative" == sessions ]]; then
            account_switcher_merge_session_tree "$source_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        else
            account_switcher_merge_session_index "$source_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        fi
    done
    if [[ "$source_home" != "$target_home" ]]; then
        for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
            if [[ "$relative" == sessions ]]; then
                account_switcher_merge_session_tree "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                }
            else
                account_switcher_merge_session_index "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                }
            fi
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        done
    fi
    account_switcher_rewrite_state_rollout_paths "$target_home" "$shared_root" "$journal" "$index" || {
        account_switcher_restore_journal "$journal" || true
        account_switcher_context_lock_release "$lock" || true
        return 1
    }
    index="$ACCOUNT_SWITCHER_MERGE_INDEX"
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        if [[ "$relative" == sessions ]]; then
            account_switcher_materialize_session_tree "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        else
            account_switcher_materialize_session_index "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        fi
        index="$ACCOUNT_SWITCHER_MERGE_INDEX"
    done
    index=$((index + 1))
    if ! account_switcher_prepare_local_state "$source_home" "$target_home" "$shared_root" "$journal" "$index"; then
        account_switcher_restore_journal "$journal" || true
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    account_switcher_context_lock_release "$lock"
    printf '%s\n' "$journal"
}

account_switcher_migrate_shared() {
    local source_home="$1" target_home="$2" context_id="$3" journal
    journal="$(account_switcher_prepare_shared "$source_home" "$target_home" "$context_id")" || return 1
    account_switcher_commit_prepared "$context_id" "$journal"
}

account_switcher_prepare_isolated() {
    local codex_home="$1" context_id="$2" shared_root lock journal index name suffix relative target shared backup
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    if ! account_switcher_assert_offline "$codex_home"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    if ! account_switcher_recover_context "$shared_root"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    journal="$shared_root/.account-switcher-migration-$$-$RANDOM"
    if ! mkdir -m 0700 -- "$journal"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    printf '%s\n' "$$" > "$journal/pid"
    index=0
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        for suffix in "" -wal -shm; do
            target="$codex_home/sqlite/$name$suffix"; shared="$shared_root/$name$suffix"; backup="$target.isolated-backup"
            if [[ -L "$target" ]] && [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]]; then
                index=$((index + 1))
                printf '%s\t%s\t%s\tdetach\n' "$target" "$shared" "$backup" > "$journal/$index"
                sync -d "$journal/$index" 2>/dev/null || true
                if ! unlink -- "$target" || { [[ -e "$backup" || -L "$backup" ]] && ! mv -- "$backup" "$target"; }; then
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                fi
            fi
        done
    done
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        target="$codex_home/$relative"; shared="$shared_root/$relative"
        if [[ "$relative" == sessions ]]; then
            account_switcher_detach_session_tree "$target" "$shared" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        else
            account_switcher_detach_session_index "$target" "$shared" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        fi
        index="$ACCOUNT_SWITCHER_MERGE_INDEX"
    done
    account_switcher_context_lock_release "$lock"
    printf '%s\n' "$journal"
}

account_switcher_detach_isolated() {
    local codex_home="$1" context_id="$2" journal
    journal="$(account_switcher_prepare_isolated "$codex_home" "$context_id")" || return 1
    account_switcher_commit_prepared "$context_id" "$journal"
}
