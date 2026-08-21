#!/usr/bin/env bash
set -Eeuo pipefail

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
state_file="$config_home/codex-desktop/account-switcher.active"
base_codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
base_electron_user_data_path="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_ELECTRON_USER_DATA_PATH:-${CODEX_ELECTRON_USER_DATA_PATH:-$config_home/codex-desktop/electron}}"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME=%s\n' "$base_codex_home"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_BASE_ELECTRON_USER_DATA_PATH=%s\n' "$base_electron_user_data_path"
profile_id="${CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE:-}"
profile_mode="${CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT:-isolated}"
context_id="${CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID:-default}"

profile_has_live_process() {
    local user_data_dir="$1" cmdline argument
    for cmdline in /proc/[0-9]*/cmdline; do
        [[ -r "$cmdline" ]] || continue
        while IFS= read -r -d '' argument; do
            [[ "$argument" == "--user-data-dir=$user_data_dir" ]] && return 0
        done < "$cmdline"
    done
    return 1
}

clear_stale_singletons() {
    local user_data_dir="$1" lock_target="" socket_target="" lock_host="" lock_pid=""
    [[ -L "$user_data_dir/SingletonLock" ]] || return 0
    profile_has_live_process "$user_data_dir" && return 0
    lock_target="$(readlink "$user_data_dir/SingletonLock")"
    if [[ "$lock_target" =~ ^(.+)-([0-9]+)$ ]]; then
        lock_host="${BASH_REMATCH[1]}"
        lock_pid="${BASH_REMATCH[2]}"
        if [[ "$lock_host" == "$(hostname)" ]] && kill -0 "$lock_pid" 2>/dev/null; then
            return 0
        fi
    else
        return 0
    fi
    if [[ -L "$user_data_dir/SingletonSocket" ]]; then
        socket_target="$(readlink "$user_data_dir/SingletonSocket")"
        [[ "$socket_target" == /* ]] || socket_target="$user_data_dir/$socket_target"
        [[ -S "$socket_target" ]] && return 0
    fi
    local name
    for name in SingletonLock SingletonSocket SingletonCookie; do
        [[ -L "$user_data_dir/$name" ]] && unlink "$user_data_dir/$name"
    done
}

if [[ -z "$profile_id" && -r "$state_file" ]]; then
    IFS= read -r profile_id < "$state_file" || true
    IFS= read -r profile_mode < <(sed -n '2p' "$state_file") || true
    IFS= read -r context_id < <(sed -n '3p' "$state_file") || true
fi

profile_id="${profile_id//[$'\r\n']/}"
profile_mode="${profile_mode:-isolated}"
context_id="${context_id:-default}"

if [[ "$profile_id" == "default" || -z "$profile_id" ]]; then
    clear_stale_singletons "$base_electron_user_data_path"
    unset CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID
    exit 0
fi
if [[ ! "$profile_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    printf 'account-switcher: refusing invalid profile id: %s\n' "$profile_id" >&2
    exit 1
fi
if [[ "$profile_mode" != "isolated" && "$profile_mode" != "shared-local" ]]; then
    printf 'account-switcher: refusing invalid profile context: %s\n' "$profile_mode" >&2
    exit 1
fi
if [[ ! "$context_id" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    printf 'account-switcher: refusing invalid context id: %s\n' "$context_id" >&2
    exit 1
fi

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
profile_root="$data_home/codex-desktop/account-profiles/$profile_id"
clear_stale_singletons "$profile_root/electron"
printf 'env CODEX_HOME=%s\n' "$profile_root/codex"
printf 'env CODEX_ELECTRON_USER_DATA_PATH=%s\n' "$profile_root/electron"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=%s\n' "$profile_id"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=%s\n' "$profile_mode"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=%s\n' "$context_id"
printf 'electron-arg --user-data-dir=%s\n' "$profile_root/electron"
