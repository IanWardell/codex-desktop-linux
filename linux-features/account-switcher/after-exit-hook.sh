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
declare -a migration_contexts=()
declare -a migration_journals=()

[[ -r "$handoff_file" ]] || exit 0
while IFS='=' read -r key value; do
    [[ "$key" =~ ^[a-z_]+$ ]] || continue
    handoff["$key"]="$value"
done < "$handoff_file"
[[ "${handoff[version]:-}" == 1 ]] || exit 1
[[ "${handoff[phase]:-}" == requested ]] || exit 0
account_switcher_validate_id "${handoff[from_id]:-}" || exit 1
account_switcher_validate_id "${handoff[from_context]:-}" || exit 1
[[ "${handoff[from_mode]:-}" == isolated || "${handoff[from_mode]:-}" == shared-local ]] || exit 1
account_switcher_validate_id "${handoff[target_id]:-}" || exit 1
account_switcher_validate_id "${handoff[target_context]:-}" || exit 1
[[ "${handoff[target_mode]:-}" == isolated || "${handoff[target_mode]:-}" == shared-local ]] || exit 1
target_previous_mode="${handoff[target_previous_mode]:-${handoff[target_mode]}}"
target_previous_context="${handoff[target_previous_context]:-${handoff[target_context]}}"
[[ "$target_previous_mode" == isolated || "$target_previous_mode" == shared-local ]] || exit 1
account_switcher_validate_id "$target_previous_context" || exit 1
if [[ -n "${handoff[remove_id]:-}" ]]; then
    account_switcher_validate_id "${handoff[remove_id]}" || exit 1
    [[ "${handoff[remove_id]}" != default && "${handoff[remove_id]}" == "${handoff[from_id]}" ]] || exit 1
fi

base_codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
source_home="$base_codex_home"
[[ "${handoff[from_id]}" == default ]] || source_home="$(account_switcher_profile_home "${handoff[from_id]}")"
target_home="$base_codex_home"
[[ "${handoff[target_id]}" == default ]] || target_home="$(account_switcher_profile_home "${handoff[target_id]}")"

restore_source_selection() {
    mkdir -p -- "$state_dir"
    {
        printf '%s\n' "${handoff[from_id]}"
        printf '%s\n' "${handoff[from_mode]}"
        printf '%s\n' "${handoff[from_context]}"
    } > "$active_file.tmp"
    chmod 600 "$active_file.tmp"
    mv -- "$active_file.tmp" "$active_file"
}

rollback_prepared_migrations() {
    local index
    for ((index=${#migration_journals[@]} - 1; index >= 0; index--)); do
        account_switcher_rollback_prepared "${migration_contexts[index]}" "${migration_journals[index]}" || true
    done
}

commit_prepared_migrations() {
    local index
    for ((index=0; index<${#migration_journals[@]}; index++)); do
        account_switcher_commit_prepared "${migration_contexts[index]}" "${migration_journals[index]}" || return 1
    done
}

fail_handoff() {
    local message="$1" rollback="${2:-1}"
    [[ "$rollback" == 1 ]] && rollback_prepared_migrations
    restore_source_selection
    rm -f -- "$ready_file" "$handoff_file"
    printf 'account-switcher: %s; restored %s\n' "$message" "${handoff[from_id]}" >&2
    exit 1
}

if [[ "${handoff[target_mode]}" == shared-local ]]; then
    journal="$(account_switcher_prepare_shared "$source_home" "$target_home" "${handoff[target_context]}")" ||
        fail_handoff "shared catalog migration failed"
    migration_contexts+=("${handoff[target_context]}")
    migration_journals+=("$journal")
else
    if [[ "$target_previous_mode" == shared-local || "$target_previous_context" != default ]] &&
       [[ "$target_home|$target_previous_context" != "$source_home|${handoff[from_context]}" ]]; then
        journal="$(account_switcher_prepare_isolated "$target_home" "$target_previous_context")" ||
            fail_handoff "target catalog isolation failed"
        migration_contexts+=("$target_previous_context")
        migration_journals+=("$journal")
    fi
    if [[ "${handoff[from_mode]}" == shared-local || "${handoff[from_context]}" != default ]]; then
        journal="$(account_switcher_prepare_isolated "$source_home" "${handoff[from_context]}")" ||
            fail_handoff "source catalog isolation failed"
        migration_contexts+=("${handoff[from_context]}")
        migration_journals+=("$journal")
    fi
fi

sed 's/^phase=.*/phase=launching/' "$handoff_file" > "$handoff_file.tmp"
mv -- "$handoff_file.tmp" "$handoff_file"
rm -f -- "$ready_file"

launcher="$app_dir/start.sh"
if [[ -n "${APPIMAGE:-}" && -x "$APPIMAGE" ]]; then
    launcher="$APPIMAGE"
elif [[ -n "${APPDIR:-}" && -x "$APPDIR/AppRun" ]]; then
    launcher="$APPDIR/AppRun"
fi

set +e
if [[ "${handoff[target_id]}" == default ]]; then
    CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE="$ready_file" \
        CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED=1 \
        CODEX_HOME="$base_codex_home" \
        env -u CODEX_ELECTRON_USER_DATA_PATH \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID \
            -u CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME \
            "$launcher" "$@" &
else
    CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE="$ready_file" \
        CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED=1 \
        CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE="${handoff[target_id]}" \
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT="${handoff[target_mode]}" \
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID="${handoff[target_context]}" \
        "$launcher" "$@" &
fi
replacement_pid=$!
set -e

for _ in {1..300}; do
    if [[ -f "$ready_file" ]]; then
        if ! commit_prepared_migrations; then
            rm -f -- "$ready_file" "$handoff_file"
            printf 'account-switcher: replacement is ready but migration commit failed\n' >&2
            exit 1
        fi
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

# Leave a failed replacement untouched for normal process cleanup.
if kill -0 "$replacement_pid" 2>/dev/null; then
    fail_handoff "replacement did not become ready; deferred catalog rollback until it exits" 0
fi
fail_handoff "replacement did not become ready"
