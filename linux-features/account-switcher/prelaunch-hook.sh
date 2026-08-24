#!/usr/bin/env bash
set -Eeuo pipefail

feature_root="${CODEX_LINUX_APP_DIR:?}/.codex-linux/features/account-switcher"
source "$feature_root/shared-state.sh"

account_switcher_is_deep_link() {
    local argument
    for argument in "$@"; do
        [[ "$argument" == codex://* ]] && return 0
    done
    return 1
}

account_switcher_app_is_running() {
    local app_binary="$CODEX_LINUX_APP_DIR/ChatGPT" process exe cmdline argument
    for process in /proc/[0-9]*; do
        [[ -d "$process" ]] || continue
        exe="$(readlink -f -- "$process/exe" 2>/dev/null || true)"
        [[ "$exe" == "$app_binary" ]] && return 0
    done
    for cmdline in /proc/[0-9]*/cmdline; do
        [[ -r "$cmdline" ]] || continue
        while IFS= read -r -d '' argument; do
            [[ "$argument" == "$app_binary" ]] && return 0
        done < "$cmdline"
    done
    return 1
}

# A URI opened by the desktop handler is a second invocation whose only job is
# to deliver the deep link to the already-running Electron instance. It must
# not attempt the offline SQLite migration guard before Electron's
# single-instance handoff receives the URI.
if account_switcher_is_deep_link "$@" && account_switcher_app_is_running; then
    exit 0
fi

# The after-exit handoff owns an uncommitted migration journal until the
# replacement signals readiness. Re-running migration here would treat that
# live journal as crash residue and undo the prepared filesystem state.
if [[ "${CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED:-0}" == 1 ]]; then
    exit 0
fi

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
state_file="$config_home/codex-desktop/account-switcher.active"
profile_id="default"
profile_mode="isolated"
context_id="default"
if [[ -r "$state_file" ]]; then
    IFS= read -r profile_id < "$state_file" || true
    IFS= read -r profile_mode < <(sed -n '2p' "$state_file") || true
    IFS= read -r context_id < <(sed -n '3p' "$state_file") || true
fi
profile_mode="${profile_mode:-isolated}"
context_id="${context_id:-default}"
account_switcher_validate_id "$profile_id" || { printf 'account-switcher: refusing invalid persisted profile id: %s\n' "$profile_id" >&2; exit 1; }
[[ "$profile_mode" == isolated || "$profile_mode" == shared-local ]] || { printf 'account-switcher: refusing invalid persisted context: %s\n' "$profile_mode" >&2; exit 1; }
account_switcher_validate_id "$context_id" || { printf 'account-switcher: refusing invalid persisted context id: %s\n' "$context_id" >&2; exit 1; }

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
if [[ "$profile_id" == default ]]; then
    codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
else
    codex_home="$data_home/codex-desktop/account-profiles/$profile_id/codex"
fi
if [[ "$profile_mode" == shared-local ]]; then
    account_switcher_migrate_shared "$codex_home" "$codex_home" "$context_id"
else
    account_switcher_detach_isolated "$codex_home" "$context_id"
fi
