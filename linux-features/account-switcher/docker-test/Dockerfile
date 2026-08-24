FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# The packaged noVNC textarea otherwise waits for a blur/change event. Codex's
# embedded browser keeps it focused when the panel closes, so send each edit
# immediately. Ubuntu's x11vnc also advertises ExtendedClipboard without
# completing noVNC's notify/request exchange, so force the compatible legacy
# ClientCutText path. Cache-bust the patched modules and fail closed if any
# upstream source anchor drifts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        dbus-x11 \
        epiphany-browser \
        imagemagick \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libatspi2.0-0t64 \
        libgtk-3-0t64 \
        libnspr4 \
        libnss3 \
        novnc \
        openbox \
        websockify \
        wmctrl \
        x11-apps \
        x11-utils \
        x11vnc \
        xclip \
        xdg-utils \
        xdotool \
        xz-utils \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash codex-test

RUN test "$(grep -Fc ".addEventListener('change', UI.clipboardSend);" /usr/share/novnc/app/ui.js)" -eq 1 \
    && sed -i "s/\.addEventListener('change', UI\.clipboardSend);/.addEventListener('input', UI.clipboardSend);/" /usr/share/novnc/app/ui.js \
    && grep -Fq ".addEventListener('input', UI.clipboardSend);" /usr/share/novnc/app/ui.js \
    && test "$(grep -Fc 'if (this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] &&' /usr/share/novnc/core/rfb.js)" -eq 1 \
    && sed -i 's/if (this\._clipboardServerCapabilitiesFormats\[extendedClipboardFormatText\] &&/if (false \&\& this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] \&\&/' /usr/share/novnc/core/rfb.js \
    && grep -Fq 'if (false && this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] &&' /usr/share/novnc/core/rfb.js \
    && test "$(grep -Fc 'import RFB from "../core/rfb.js";' /usr/share/novnc/app/ui.js)" -eq 1 \
    && sed -i 's#import RFB from "../core/rfb.js";#import RFB from "../core/rfb.js?codex-clipboard-v1";#' /usr/share/novnc/app/ui.js \
    && test "$(grep -Fc 'src="app/ui.js"' /usr/share/novnc/vnc.html)" -eq 1 \
    && sed -i 's#src="app/ui.js"#src="app/ui.js?codex-clipboard-v1"#' /usr/share/novnc/vnc.html

COPY packaging/linux/codex-desktop.desktop /usr/share/applications/codex-desktop.desktop
COPY linux-features/account-switcher/docker-test/codex-desktop /usr/bin/codex-desktop
COPY linux-features/account-switcher/docker-test/openbox-menu.xml /etc/xdg/openbox/menu.xml
COPY linux-features/account-switcher/docker-test/entrypoint.sh /usr/local/bin/account-switcher-gui

RUN chmod 0755 /usr/bin/codex-desktop /usr/local/bin/account-switcher-gui

EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/account-switcher-gui"]
