# Rapid Account Switcher

This opt-in feature adds **Switch account** directly below **Log out** in the
bottom-left profile menu. It relaunches Codex with a saved local profile,
without calling upstream logout and without deleting the previous profile.

Each isolated profile has its own Electron user-data directory, `CODEX_HOME`,
credentials, plugins, configuration, rollouts, and SQLite state. The first
profile is the existing default account. New profile data is stored under
`${XDG_DATA_HOME:-~/.local/share}/codex-desktop/account-profiles/`.

The switch dialog offers an experimental **Keep the local projects/thread
catalog** mode. Its On/Off choice is saved in the account-switcher registry and
stays in effect across dialog openings, account switches, and app relaunches
until the user changes it. When enabled, it links the SQLite catalogs into a
private shared context. This covers
`codex.db`, `codex-dev.db`, and the thread-summary catalogs used by current
Codex builds, the local project metadata in `.codex-global-state.json`, and the
local rollout/session files needed to resume those threads. Enabling sharing
after it was disabled starts a fresh shared context seeded by the active
profile, so an older shared catalog cannot replace work created immediately
before a switch. It does not share credentials, Electron state, or plugins. If a
profile already has an isolated catalog or project state, it is retained as an
`.isolated-backup` file before the shared catalog is linked. Remote projects and
threads still require the selected account to be authorized by OpenAI; this
client cannot grant cross-account access.

The dialog renders saved login names and last-known usage values immediately.
It refreshes usage for all profiles concurrently in the background and changes
an on-screen value only when the live result differs from the cached value.

Switching starts the replacement profile, terminates the old instance's Linux
process tree, and force-exits its Electron main process after the handoff state
is written. This prevents orphaned renderer, utility, and app-server processes
from accumulating during repeated switches.

Before a profile is launched, the feature removes Chromium singleton symlinks
only when no local process owns that exact profile, the recorded lock process
is gone, and its singleton socket is unavailable. This recovers profiles left
locked by a crashed app or a replaced container without disturbing a live app.

Only profile names and context settings are stored in
`${XDG_CONFIG_HOME:-~/.config}/codex-desktop/account-switcher.json`. The
feature never copies or displays tokens, `auth.json`, keyring data, or database
credentials. Removing a profile from the registry does not remove its files.

Enable it in the ignored local feature configuration:

```json
{
  "enabled": ["account-switcher"]
}
```

Then rebuild the app and run the focused tests:

```bash
node --test linux-features/account-switcher/test.js
```
