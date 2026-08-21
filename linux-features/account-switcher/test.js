#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  MAIN_MARKER,
  PRELOAD_MARKER,
  MENU_MARKER,
  RUNTIME_MARKER,
  applyMainBundlePatch,
  applyPreloadPatch,
  applyProfileMenuPatch,
} = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");

function withFeatureConfig(enabled, fn) {
  const original = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
  try {
    return fn();
  } finally {
    if (original == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot }).some((entry) => entry.featureId === "account-switcher"), false);
  });
  withFeatureConfig(["account-switcher"], () => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((entry) => entry.id),
      [
        "feature:account-switcher:main-profile-ipc",
        "feature:account-switcher:preload-profile-bridge",
        "feature:account-switcher:account-switcher-ui",
      ],
    );
  });
});

test("main patch is idempotent and fails closed on anchor drift", () => {
  const fixture = "let _e=!1,ve=()=>null,ye=()=>null,be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);ure({});";
  const patched = applyMainBundlePatch(fixture);
  assert.match(patched, new RegExp(MAIN_MARKER));
  assert.equal(applyMainBundlePatch(patched), patched);
  const missing = fixture.replace("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);", "");
  assert.equal(applyMainBundlePatch(missing), missing);
  assert.equal(applyMainBundlePatch(fixture + fixture), fixture + fixture);
});

test("preload bridge patch is idempotent and fails closed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-preload-"));
  try {
    const buildDir = path.join(tempDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const target = path.join(buildDir, "preload.js");
    fs.writeFileSync(target, "const L={usesOwlAppShell:()=>E};");
    assert.equal(applyPreloadPatch(tempDir).changed, 1);
    const patched = fs.readFileSync(target, "utf8");
    assert.match(patched, new RegExp(PRELOAD_MARKER));
    assert.match(patched, /refreshLinuxAccountProfiles/);
    assert.match(patched, /action:"refresh"/);
    assert.match(patched, /setLinuxAccountSwitcherSettings/);
    assert.match(patched, /action:"set-settings"/);
    assert.equal(applyPreloadPatch(tempDir).changed, 0);
    fs.writeFileSync(target, "const L={usesOwlAppShell:()=>E}; const M={usesOwlAppShell:()=>E};");
    assert.equal(applyPreloadPatch(tempDir).changed, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("profile menu adds Switch account below Log out and appends runtime once", () => {
  const fixture = "codex.profileDropdown.logOut;children:[v,y,o,b,h,S,i,w,T]})";
  const patched = applyProfileMenuPatch(fixture);
  assert.match(patched, new RegExp(MENU_MARKER));
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, /profile\.login/);
  assert.match(patched, /profile\.usagePercent/);
  assert.match(patched, /Usage: /);
  assert.match(patched, /const cachedRequest=api\.getLinuxAccountProfiles\(\),refreshRequest=api\.refreshLinuxAccountProfiles\?\.\(\)/);
  assert.match(patched, /if\(name\.textContent!==nextName\)name\.textContent=nextName/);
  assert.match(patched, /if\(meta\.textContent!==nextMeta\)meta\.textContent=nextMeta/);
  assert.match(patched, /refreshRequest\.then\(\(state\)=>cachedRequest\.then/);
  assert.match(patched, /als-switch/);
  assert.match(patched, /Keep local projects and threads/);
  assert.match(patched, /keepLocalProjectsThreads/);
  assert.match(patched, /shared\.checked=state\.keepLocalProjectsThreads===true/);
  assert.match(patched, /persistSharedState/);
  assert.match(patched, /sharedState\.textContent=shared\.checked\?\"On\":\"Off\"/);
  assert.equal(applyProfileMenuPatch(patched), patched);
  assert.equal(applyProfileMenuPatch("profile menu drift"), "profile menu drift");
});

test("account relaunch kills the old Electron process tree after spawning the replacement", () => {
  const fixture = "const child_process=require(\"node:child_process\");l.ipcMain.handle(\"codex_linux_account_switcher\",async()=>null);";
  const patched = applyMainBundlePatch(fixture.replace(
    "l.ipcMain.handle",
    "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);l.ipcMain.handle",
  ));
  assert.match(patched, /codexLinuxAccountSwitcherPrepareSharedContext/);
  assert.match(patched, /codexLinuxAccountSwitcherPrepareIsolatedContext/);
  assert.match(patched, /codexLinuxAccountSwitcherRestoreIsolatedPath/);
  assert.match(patched, /codexLinuxAccountSwitcherKeepLocalProjectsThreads/);
  assert.match(patched, /if\(action==="list"\)\{\s+const details=registry\.profiles\.map/);
  assert.match(patched, /if\(action==="refresh"\)/);
  assert.match(patched, /codexLinuxAccountSwitcherCachedDetails/);
  assert.match(patched, /action==="set-settings"/);
  assert.match(patched, /codex-global-state\.json/);
  assert.match(patched, /isolated-backup/);
  assert.match(patched, /codexLinuxAccountSwitcherChildProcess\.spawn/);
  assert.match(patched, /startsWith\(\"--user-data-dir=\"\)/);
  assert.match(patched, /args\.push\(\"--user-data-dir=\"\+userDataDir\)/);
  assert.match(patched, /codexLinuxAccountSwitcherDescendantPids\(process\.pid\)/);
  assert.match(patched, /codexLinuxAccountSwitcherStopOldDescendants\(oldDescendants\)/);
  assert.match(patched, /codexLinuxAccountSwitcherClearStaleSingletons\(userDataDir\)/);
  assert.match(patched, /codexLinuxAccountSwitcherProcessOwnsProfile/);
  assert.match(patched, /\["SingletonLock","SingletonSocket","SingletonCookie"\]/);
  assert.match(patched, /process\.kill\(pid,signal\)/);
  assert.match(patched, /\[\"SIGTERM\",\"SIGKILL\"\]/);
  assert.match(patched, /l\.app\.exit\(0\)/);
  assert.doesNotMatch(patched, /setTimeout\(\(\)=>l\.app\.quit\(\),25\)/);
});

test("shared mode includes rollout files and persists a fresh context generation", () => {
  const fixture = "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);";
  const patched = applyMainBundlePatch(fixture);
  assert.match(patched, /\[\"sessions\",\"session_index\.jsonl\",\"shell_snapshots\"\]/);
  assert.match(patched, /registry\.sharedContextId=\"shared-\"\+Date\.now\(\)\.toString\(36\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWriteActive\(active\)/);
  assert.match(patched, /source\.startsWith\(managedRoot\+codexLinuxAccountSwitcherPath\.sep\)/);
  assert.match(patched, /codexLinuxAccountSwitcherFs\.cpSync\(source,shared,\{recursive:true\}\)/);
  assert.doesNotMatch(patched, /copyFileSync\(shared,target\)/);
});

test("profile identity lookup keeps the base account home stable after relaunch", () => {
  const fixture = "const child_process=require(\"node:child_process\");l.ipcMain.handle(\"codex_linux_account_switcher\",async()=>null);";
  const patched = applyMainBundlePatch(fixture.replace(
    "l.ipcMain.handle",
    "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);l.ipcMain.handle",
  ));
  assert.match(patched, /CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME/);
  assert.match(patched, /profile\.id===\"default\"\?codexLinuxAccountSwitcherBaseCodexHome/);
  assert.doesNotMatch(patched, /delete environment\.CODEX_HOME/);
});

test("launcher routes the active named profile", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-launcher-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const script = path.join(__dirname, "launcher-hook.sh");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], {
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `env CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME=${path.join(home, ".codex")}`,
      `env CODEX_LINUX_ACCOUNT_SWITCHER_BASE_ELECTRON_USER_DATA_PATH=${path.join(home, ".config", "codex-desktop", "electron")}`,
      `env CODEX_HOME=${path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work", "codex")}`,
      `env CODEX_ELECTRON_USER_DATA_PATH=${path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work", "electron")}`,
      "env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=work",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=shared-local",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=team",
      `electron-arg --user-data-dir=${path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work", "electron")}`,
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher removes stale Chromium singleton links but preserves a live lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-singletons-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    const dataHome = path.join(home, ".local", "share");
    const profileDir = path.join(dataHome, "codex-desktop", "account-profiles", "work", "electron");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      fs.symlinkSync(name === "SingletonLock" ? "retired-container-999999" : path.join(tempDir, `missing-${name}`), path.join(profileDir, name));
    }
    const script = path.join(__dirname, "launcher-hook.sh");
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome };
    const staleResult = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(staleResult.status, 0, staleResult.stderr);
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      assert.throws(() => fs.lstatSync(path.join(profileDir, name)), { code: "ENOENT" });
    }

    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(profileDir, "SingletonLock"));
    fs.symlinkSync(path.join(tempDir, "missing-live-socket"), path.join(profileDir, "SingletonSocket"));
    const liveResult = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(liveResult.status, 0, liveResult.stderr);
    assert.equal(fs.readlinkSync(path.join(profileDir, "SingletonLock")), `${os.hostname()}-${process.pid}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared prelaunch preserves an existing profile catalog before linking the shared catalog", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-shared-hook-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const profileHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    const target = path.join(profileHome, "sqlite", "codex.db");
    const sharedDev = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex-dev.db");
    const targetDev = path.join(profileHome, "sqlite", "codex-dev.db");
    const sharedState = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex-global-state.json");
    const targetState = path.join(profileHome, ".codex-global-state.json");
    const sharedSessions = path.join(dataHome, "codex-desktop", "account-contexts", "team", "sessions");
    const targetSessions = path.join(profileHome, "sessions");
    const targetSessionIndex = path.join(profileHome, "session_index.jsonl");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(target, "profile catalog");
    fs.writeFileSync(shared, "shared catalog");
    fs.writeFileSync(targetDev, "profile dev catalog");
    fs.writeFileSync(sharedDev, "shared dev catalog");
    fs.writeFileSync(targetState, "profile project state");
    fs.writeFileSync(sharedState, "shared project state");
    fs.mkdirSync(targetSessions, { recursive: true });
    fs.writeFileSync(path.join(targetSessions, "rollout.jsonl"), "profile rollout");
    fs.writeFileSync(targetSessionIndex, "profile session index");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: {
        HOME: home,
        XDG_DATA_HOME: dataHome,
        CODEX_HOME: profileHome,
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT: "shared-local",
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID: "team",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readlinkSync(target), shared);
    assert.equal(fs.readFileSync(`${target}.isolated-backup`, "utf8"), "profile catalog");
    assert.equal(fs.readFileSync(shared, "utf8"), "shared catalog");
    assert.equal(fs.readlinkSync(targetDev), sharedDev);
    assert.equal(fs.readFileSync(`${targetDev}.isolated-backup`, "utf8"), "profile dev catalog");
    assert.equal(fs.readFileSync(sharedDev, "utf8"), "shared dev catalog");
    assert.equal(fs.readlinkSync(targetState), sharedState);
    assert.equal(fs.readFileSync(`${targetState}.isolated-backup`, "utf8"), "profile project state");
    assert.equal(fs.readFileSync(sharedState, "utf8"), "shared project state");
    assert.equal(fs.readlinkSync(targetSessions), sharedSessions);
    assert.equal(fs.readFileSync(path.join(sharedSessions, "rollout.jsonl"), "utf8"), "profile rollout");
    assert.equal(fs.readlinkSync(targetSessionIndex), path.join(path.dirname(sharedSessions), "session_index.jsonl"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
