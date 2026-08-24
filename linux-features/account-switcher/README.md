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
 private shared context. It links only the allowlisted SQLite catalogs:
`codex.db`, `codex-dev.db`, and the thread-summary catalogs used by current
Codex builds, including their SQLite `-wal` and `-shm` sidecars. Credentials,
auth files, Electron state, plugins, shell snapshots, rollout/session files,
and account-scoped metadata are never shared. Migration runs only while both
profiles are offline, with a journal, rollback, and crash recovery. If a
profile already has an isolated catalog, it is retained as an
`.isolated-backup` file before the shared catalog is linked. Remote projects
and threads still require the selected account to be authorized by OpenAI;
this client cannot grant cross-account access.

The dialog renders saved login names and last-known usage values immediately.
It refreshes usage for all profiles concurrently in the background and changes
an on-screen value only when the live result differs from the cached value.

Switching records a handoff, exits through the normal launcher/AppRun
lifecycle, waits for the replacement to signal readiness, and restores the
previous selection if startup fails. It does not force-kill arbitrary
renderer, utility, or app-server descendants.

When the active profile logs out, the main process observes that profile's own
auth file after a debounce. It hands off to the previously active
authenticated profile, or another authenticated saved profile. If none
remain, Codex keeps the upstream login screen focused. Selecting a logged-out
profile intentionally creates a bounded login-pending window so browser
authentication can complete without an immediate fallback.

When that login-pending profile is signed out and another saved profile
exists, the upstream login screen keeps a **Switch account** control in its
bottom-left corner. The switcher labels profiles without current
authentication as **Signed out**, so the user can return to an authenticated
profile without being trapped in the sign-in route.

Signed-out named profiles also show an **×** control. It permanently deletes
that profile's registry entry and its exact managed on-disk profile directory.
Removing the currently active signed-out profile first hands off to another
authenticated profile and waits for replacement readiness before deleting it;
a failed handoff preserves the profile for rollback. The default profile and
profiles that are still authenticated cannot be removed.

Before a profile is launched, the feature removes Chromium singleton symlinks
only when no local process owns that exact profile, the recorded lock process
is gone, and its singleton socket is unavailable. This recovers profiles left
locked by a crashed app or a replaced container without disturbing a live app.

Profile names, context settings, cached login/usage metadata, timestamps, the
previous profile ID, a temporary login-pending deadline, and the shared-context generation are stored in
`${XDG_CONFIG_HOME:-~/.config}/codex-desktop/account-switcher.json`. The
feature never copies or displays tokens, `auth.json`, keyring data, or database
credentials. Deleting a signed-out named profile removes all data beneath its
path-contained managed profile root.

Background usage refresh requests the authenticated
`https://chatgpt.com/backend-api/wham/usage` endpoint with the selected
profile's in-memory access token and account ID. Tokens are not written to the
registry or logs, and a late response is merged only into the profile version
that was read before the request, preserving newer registry mutations.

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

For an isolated browser/login lifecycle test, build the repository Docker
harness and mount the generated app read-only:

```bash
docker build -t codex-account-switcher-gui:test \
  -f linux-features/account-switcher/docker-test/Dockerfile .
```

The harness uses the production desktop entry and launcher for `codex://`
callbacks. Its `--no-sandbox` wrapper and WebKitGTK sandbox escape hatch are
strictly Docker-test-only and are not installed by native packages.
