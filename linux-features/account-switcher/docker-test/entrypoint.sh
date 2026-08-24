#!/usr/bin/env bash
set -Eeuo pipefail

test_user="codex-test"
test_home="/home/codex-test"
display="${CODEX_DOCKER_DISPLAY:-:100}"
display_number="${display#:}"

[[ "$display_number" =~ ^[0-9]+$ ]] || {
    printf 'invalid CODEX_DOCKER_DISPLAY: %s\n' "$display" >&2
    exit 2
}

install -d -o "$test_user" -g "$test_user" -m 0755 "$test_home"
chown "$test_user:$test_user" "$test_home"

# The user owns the D-Bus session. Starting dbus-run-session as root and then
# dropping privileges prevents xdg-open and the codex:// callback from sharing
# the app's desktop session.
exec runuser -u "$test_user" -- \
    env CODEX_DOCKER_DISPLAY_NUMBER="$display_number" \
    dbus-run-session -- \
    bash -lc '
        set -Eeuo pipefail
        export DISPLAY="'"$display"'"
        export HOME="'"$test_home"'"
        export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

        # Recover only this validated display after an unclean container stop.
        # Account handoffs do not restart the container: this shell owns the
        # desktop session while Codex is free to exit and relaunch beneath it.
        if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
            rm -f -- "/tmp/.X${CODEX_DOCKER_DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${CODEX_DOCKER_DISPLAY_NUMBER}"
        fi

        Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac >/tmp/xvfb.log 2>&1 &
        xvfb_pid=$!
        for attempt in $(seq 1 100); do
            xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
            if ! kill -0 "$xvfb_pid" 2>/dev/null; then
                cat /tmp/xvfb.log >&2
                exit 1
            fi
            sleep 0.2
        done
        xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || {
            printf "Xvfb did not become ready on %s\n" "$DISPLAY" >&2
            exit 1
        }

        openbox >/tmp/openbox.log 2>&1 &
        openbox_pid=$!
        # noVNC sends browser clipboard changes as RFB ClientCutText. x11vnc
        # enables CLIPBOARD polling and setting by default; do not add the
        # unsupported positive-form flags or either -noclipboard option.
        x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5901 \
            >/tmp/x11vnc.log 2>&1 &
        x11vnc_pid=$!
        websockify --web=/usr/share/novnc 6080 localhost:5901 >/tmp/novnc.log 2>&1 &
        websockify_pid=$!

        desktop_pids=("$xvfb_pid" "$openbox_pid" "$x11vnc_pid" "$websockify_pid")
        stop_desktop() {
            trap - EXIT INT TERM HUP
            kill "${desktop_pids[@]}" 2>/dev/null || true
            wait "${desktop_pids[@]}" 2>/dev/null || true
        }
        trap stop_desktop EXIT
        trap "exit 0" INT TERM HUP

        xdg-settings set default-web-browser org.gnome.Epiphany.desktop
        xdg-mime default codex-desktop.desktop x-scheme-handler/codex

        env CODEX_LINUX_DISABLE_USAGE_REPORTING=1 \
            /opt/codex-source/start.sh --no-sandbox &
        launcher_pid=$!

        # start.sh intentionally returns after a successful account handoff;
        # its replacement app remains in this D-Bus/X11 session. Keep the
        # desktop and noVNC endpoint alive whether Codex is switched, closed,
        # or reopened from inside the desktop.
        set +e
        wait "$launcher_pid"
        launcher_status=$?
        set -e
        printf "Codex launcher exited with status %s; desktop remains available\n" "$launcher_status" >&2

        while true; do
            for desktop_pid in "${desktop_pids[@]}"; do
                if ! kill -0 "$desktop_pid" 2>/dev/null; then
                    printf "desktop service exited unexpectedly: pid %s\n" "$desktop_pid" >&2
                    exit 1
                fi
            done
            sleep 1 &
            wait $! || true
        done
    '
