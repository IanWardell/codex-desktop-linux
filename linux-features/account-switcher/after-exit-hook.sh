#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?account-switcher: CODEX_LINUX_APP_DIR is required}"
# shellcheck source=/dev/null
source "$app_dir/.codex-linux/features/account-switcher/shared-state.sh"

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
state_dir="$config_home/codex-desktop"
active_file="$state_dir/account-switcher.active"
handoff_file="$state_dir/account-switcher.handoff"
remove_complete_file="$state_dir/account-switcher.remove-complete"
ready_file="$state_dir/account-switcher.ready.$$"
declare -A handoff=()

[[ -r "$handoff_file" ]] || exit 0
while IFS='=' read -r key value; do
    [[ "$key" =~ ^[a-z_]+$ ]] || continue
    handoff["$key"]="$value"
done < "$handoff_file"
[[ "${handoff[phase]:-}" == requested ]] || exit 0
account_switcher_validate_id "${handoff[from_id]:-}" || exit 1
account_switcher_validate_id "${handoff[target_id]:-}" || exit 1
account_switcher_validate_id "${handoff[target_context]:-}" || exit 1
[[ "${handoff[target_mode]:-}" == isolated || "${handoff[target_mode]:-}" == shared-local ]] || exit 1
if [[ -n "${handoff[remove_id]:-}" ]]; then
    account_switcher_validate_id "${handoff[remove_id]}" || exit 1
    [[ "${handoff[remove_id]}" != default && "${handoff[remove_id]}" == "${handoff[from_id]}" ]] || exit 1
fi

base_codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
source_home="$base_codex_home"
[[ "${handoff[from_id]}" == default ]] || source_home="$(account_switcher_profile_home "${handoff[from_id]}")"
target_home="$base_codex_home"
[[ "${handoff[target_id]}" == default ]] || target_home="$(account_switcher_profile_home "${handoff[target_id]}")"

if [[ "${handoff[target_mode]}" == shared-local ]]; then
    account_switcher_migrate_shared "$source_home" "$target_home" "${handoff[target_context]}"
else
    account_switcher_detach_isolated "$target_home" "${handoff[target_context]}"
fi

sed 's/^phase=.*/phase=launching/' "$handoff_file" > "$handoff_file.tmp"
mv -- "$handoff_file.tmp" "$handoff_file"
rm -f -- "$ready_file"

launcher="$app_dir/start.sh"
if [[ -n "${APPDIR:-}" && -x "$APPDIR/AppRun" ]]; then
    launcher="$APPDIR/AppRun"
fi

set +e
if [[ "${handoff[target_id]}" == default ]]; then
    CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE="$ready_file" \
        CODEX_HOME="$base_codex_home" \
        env -u CODEX_ELECTRON_USER_DATA_PATH \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME \
            "$launcher" "$@" &
else
    CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE="$ready_file" \
        CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE="${handoff[target_id]}" \
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT="${handoff[target_mode]}" \
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID="${handoff[target_context]}" \
        "$launcher" "$@" &
fi
replacement_pid=$!
set -e

for _ in {1..300}; do
    if [[ -f "$ready_file" ]]; then
        if [[ -n "${handoff[remove_id]:-}" ]]; then
            if ! account_switcher_delete_profile "${handoff[remove_id]}"; then
                rm -f -- "$ready_file" "$handoff_file"
                printf 'account-switcher: replacement is ready but profile removal failed: %s\n' "${handoff[remove_id]}" >&2
                exit 1
            fi
            printf '%s\n' "${handoff[remove_id]}" > "$remove_complete_file.tmp"
            chmod 600 "$remove_complete_file.tmp"
            mv -- "$remove_complete_file.tmp" "$remove_complete_file"
        fi
        rm -f -- "$ready_file" "$handoff_file"
        exit 0
    fi
    if ! kill -0 "$replacement_pid" 2>/dev/null; then
        break
    fi
    sleep 0.1
done

# The new instance did not reach readiness. Restore the source selection and
# leave the failed replacement untouched for normal process cleanup.
mkdir -p -- "$state_dir"
{
    printf '%s\n' "${handoff[from_id]}"
    printf '%s\n' "${handoff[from_mode]:-isolated}"
    printf '%s\n' "${handoff[from_context]:-default}"
} > "$active_file.tmp"
chmod 600 "$active_file.tmp"
mv -- "$active_file.tmp" "$active_file"
rm -f -- "$ready_file" "$handoff_file"
printf 'account-switcher: replacement did not become ready; restored %s\n' "${handoff[from_id]}" >&2
exit 1
