# Account Switcher Modes

This opt-in feature adds **Switch account** to both layouts of the
bottom-left profile menu. It relaunches Codex with a saved local profile,
without calling upstream logout and without deleting the previous profile.

In **Settings → General**, **Use upstream account switcher** chooses the
implementation immediately. It defaults to **Off** (our profile switcher).
The choice is saved in the private account-switcher registry and applies to
all windows and profiles. An active account change must finish before changing
this preference.

With the toggle **On**, **Switch account** opens upstream's native account menu.
It encrypts remembered ChatGPT credentials using Linux Secret Service and
`secret-tool`, restarts the local app-server connection, and reloads the
windows without relaunching the desktop app. Accounts use the current
profile's chats, settings, and plugins. Upstream checks for active tasks and
pending requests before switching. The package includes the `libsecret-tools`
dependency on Debian/Ubuntu. The desktop keyring must be available.

The two implementations keep separate saved-account lists. Enabling upstream
mode does not import our saved profiles or migrate their history. Upstream's
credential vault belongs to the currently launched profile. Switching back
restores access to our profile list; it does not undo a login selected through
upstream within the current profile. Our automatic logout fallback is disabled
while upstream mode is selected.

Each isolated profile has its own Electron user-data directory, `CODEX_HOME`,
credentials, plugins, configuration, rollouts, and SQLite state. Local app-server
connections use file-based credential storage inside that profile; remote
connections retain upstream credential storage. The first
profile is the existing default account. New profile data is stored under
`${XDG_DATA_HOME:-~/.local/share}/codex-desktop/account-profiles/`.

The switch dialog offers an experimental **Keep the local projects/thread
catalog** mode. Its On/Off choice is saved in the account-switcher registry and
stays in effect across dialog openings, account switches, and app relaunches
until the user changes it. When enabled, it migrates only the local-project
catalog data into a private shared context. It migrates only the allowlisted
SQLite catalogs:
`codex.db`, `codex-dev.db`, and the thread-summary catalogs used by current
Codex builds, including their SQLite `-wal` and `-shm` sidecars. Credentials,
auth files, Electron state, plugins, shell snapshots, and account-scoped
metadata are never shared. Offline session rollout files and the session index
needed to resume shared local threads are merged into the private context. The
active profile then receives regular session files and a regular SQLite index
inside its own `CODEX_HOME`; shared files are hard-linked where possible, so
the app-server never receives a rollout path outside the active profile.
When the destination already has a `state_*.sqlite` index, local thread rows
whose rollout files are in the shared context, along with their local project
rows, are merged from the active profile. Remote thread rows stay profile-local.
Shared rollout paths are rewritten to the destination profile while SQLite is
offline, with WAL/SHM backup and rollback. The rollout backfill watermark is
reset so Codex also indexes shared sessions that have no existing row in the
destination. The local-project list, thread-to-project assignments,
descriptions, client bindings, and writable roots use a private
`local-project-state.json` sidecar. The rest of each profile's global state
remains separate. Migration runs only while both profiles are offline.
Per-context locks serialize migrations, while a separate
cold-launch guard remains held until Electron is visible so concurrent
launchers cannot pass the offline check together. Lock, journal, and handoff
owners include the Linux boot ID and process start time rather than trusting a
reusable PID alone. Uncommitted journals provide rollback and crash recovery.
A handoff commits its migration only after the replacement signals readiness.
Commit intent and path-contained journal identities remain in the handoff
record until every context is committed, so a partial cleanup or lock failure
is retried on the next offline launch instead of rolling back state used by the
replacement. If an unready replacement remains alive, rollback is deferred
until the next offline launch.
Closed SQLite rollback-journal files fail closed and must be recovered by
SQLite before a shared-state migration can proceed. An untouched isolated
profile does not enter the migration path, allowing SQLite itself to recover a
rollback journal during ordinary startup.
When an active profile rejoins its retained shared context, its newer offline
isolated catalog is transactionally promoted before the shared link is
restored, so work created while sharing was off is not hidden by the older
context copy. An inactive target profile's isolated catalog is retained as an
`.isolated-backup` before linking it to the active shared catalog. Remote
projects and threads still require the selected account to be authorized by
OpenAI; this client cannot grant cross-account access.

Changing shared mode relaunches through the same handoff protocol. Turning it
off retains the prior context only as transactional detachment input, then
persists the active profile as `isolated/default`. A new profile with no global
state leaves existing shared project metadata intact.

The dialog renders saved login names and last-known usage values immediately.
It refreshes usage for all profiles concurrently in the background and changes
an on-screen value only when the live result differs from the cached value.

Switching records a handoff, exits through the normal launcher lifecycle,
re-enters a packaged AppImage or extracted AppDir through the `AppRun` that is
verified to contain this installation, waits for replacement readiness, and
restores the previous selection if startup fails. It does not force-kill
arbitrary renderer, utility, or app-server descendants. The exiting launcher
first closes the launchable handoff phase, then the final-exit transition hook
claims the offline migration after all ordinary cleanup hooks. The replacement starts without replaying the
original startup URI or window flags.

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
previous profile ID, a temporary login-pending deadline, and the shared-context
generation are stored in
`${XDG_CONFIG_HOME:-~/.config}/codex-desktop/account-switcher.json`. The
same private configuration directory holds the current selection and temporary
handoff metadata (lifecycle phase, boot/process identity, context IDs, and
migration journal basenames); successful handoffs remove that recovery record.
The feature never copies or displays tokens, `auth.json`, keyring data, or database
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
