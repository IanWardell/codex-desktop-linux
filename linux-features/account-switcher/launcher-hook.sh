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

if [[ -z "$profile_id" && -r "$state_file" ]]; then
    IFS= read -r profile_id < "$state_file" || true
    IFS= read -r profile_mode < <(sed -n '2p' "$state_file") || true
    IFS= read -r context_id < <(sed -n '3p' "$state_file") || true
fi

profile_id="${profile_id//[$'\r\n']/}"
profile_mode="${profile_mode:-isolated}"
context_id="${context_id:-default}"

if [[ "$profile_id" == "default" || -z "$profile_id" ]]; then
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
printf 'env CODEX_HOME=%s\n' "$profile_root/codex"
printf 'env CODEX_ELECTRON_USER_DATA_PATH=%s\n' "$profile_root/electron"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=%s\n' "$profile_id"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=%s\n' "$profile_mode"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=%s\n' "$context_id"
printf 'electron-arg --user-data-dir=%s\n' "$profile_root/electron"
