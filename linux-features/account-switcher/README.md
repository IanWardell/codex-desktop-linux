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
Codex builds, plus the local project metadata in `.codex-global-state.json`.
It does not share credentials, Electron state, rollout files, or plugins. If a
profile already has an isolated catalog or project state, it is retained as an
`.isolated-backup` file before the shared catalog is linked. Remote projects and
threads still require the selected account to be authorized by OpenAI; this
client cannot grant cross-account access.

Switching starts the replacement profile and force-exits the old Electron
instance after the handoff state is written. This prevents stale renderer and
app-server process trees from accumulating during repeated switches.

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
