#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

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

function stageSharedStateHelper(appDir) {
  const target = path.join(appDir, ".codex-linux", "features", "account-switcher");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "shared-state.sh"), path.join(target, "shared-state.sh"));
}

test("Docker desktop supervisor survives Codex exits and account handoffs", () => {
  const entrypoint = fs.readFileSync(path.join(__dirname, "docker-test", "entrypoint.sh"), "utf8");
  const menu = fs.readFileSync(path.join(__dirname, "docker-test", "openbox-menu.xml"), "utf8");
  assert.doesNotMatch(entrypoint, /exec env CODEX_LINUX_DISABLE_USAGE_REPORTING/);
  assert.match(entrypoint, /\/opt\/codex-source\/start\.sh --no-sandbox &/);
  assert.match(entrypoint, /desktop_pids=\("\$xvfb_pid" "\$openbox_pid" "\$x11vnc_pid" "\$websockify_pid"\)/);
  assert.match(entrypoint, /while true; do[\s\S]*kill -0 "\$desktop_pid"/);
  assert.match(entrypoint, /Codex launcher exited with status .*desktop remains available/);
  assert.match(menu, /<execute>\/usr\/bin\/codex-desktop<\/execute>/);
  assert.match(menu, /<execute>\/usr\/bin\/epiphany<\/execute>/);
});

function runLogoutMonitorScenario({ activeAuth, fallbackAuth, loginPendingMs = null, removeActiveAuth = false, expectIdle = false }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-logout-"));
  const home = path.join(tempDir, "home");
  const configHome = path.join(home, ".config");
  const dataHome = path.join(home, ".local", "share");
  const configDir = path.join(configHome, "codex-desktop");
  const baseCodexHome = path.join(home, ".codex");
  const workCodexHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
  const actionPath = path.join(home, "monitor-action");
  const activeAuthPath = path.join(workCodexHome, "auth.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(baseCodexHome, { recursive: true });
  fs.mkdirSync(workCodexHome, { recursive: true });
  const profiles = [
    { id: "default", name: "Default", contextMode: "isolated", contextId: "default" },
    {
      id: "work",
      name: "Work",
      contextMode: "isolated",
      contextId: "default",
      ...(loginPendingMs != null ? { loginPendingUntil: new Date(Date.now() + loginPendingMs).toISOString() } : {}),
    },
  ];
  fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, previousProfileId: "default", profiles }, null, 2)}\n`);
  fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n");
  const auth = `${JSON.stringify({ tokens: { access_token: "fixture-token" } })}\n`;
  if (activeAuth) fs.writeFileSync(activeAuthPath, auth);
  if (fallbackAuth) fs.writeFileSync(path.join(baseCodexHome, "auth.json"), auth);

  const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let beforeQuit=null;
const l={app:{whenReady:()=>Promise.resolve(),once:(name,handler)=>{if(name==="before-quit")beforeQuit=handler},quit:()=>{beforeQuit?.();fs.writeFileSync(${JSON.stringify(actionPath)},"quit");process.exit(0)},focus:()=>{fs.writeFileSync(${JSON.stringify(actionPath)},"focus");process.exit(0)}},ipcMain:{handle:()=>{}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
${removeActiveAuth ? `setTimeout(()=>fs.rmSync(${JSON.stringify(activeAuthPath)},{force:true}),100);` : ""}
setTimeout(()=>{${expectIdle ? `fs.writeFileSync(${JSON.stringify(actionPath)},"idle");process.exit(0)` : "process.exit(91)"}},1800);
`;
  const patched = applyMainBundlePatch(fixture);
  const result = spawnSync(process.execPath, ["-e", patched], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      CODEX_HOME: workCodexHome,
      CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME: baseCodexHome,
      CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE: "work",
      CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT: "isolated",
      CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID: "default",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  const output = {
    result,
    action: fs.existsSync(actionPath) ? fs.readFileSync(actionPath, "utf8") : null,
    active: fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"),
    handoff: fs.existsSync(path.join(configDir, "account-switcher.handoff"))
      ? fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8")
      : null,
    registry: JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8")),
  };
  fs.rmSync(tempDir, { recursive: true, force: true });
  return output;
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
    assert.match(patched, /removeLinuxAccountProfile/);
    assert.match(patched, /action:"remove"/);
    assert.match(patched, /setLinuxAccountSwitcherSettings/);
    assert.match(patched, /action:"set-settings"/);
    assert.equal(applyPreloadPatch(tempDir).changed, 0);
    fs.writeFileSync(target, "const L={usesOwlAppShell:()=>E}; const M={usesOwlAppShell:()=>E};");
    assert.equal(applyPreloadPatch(tempDir).changed, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("duplicate preload anchors are reported as enabled-feature drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-report-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
    fs.writeFileSync(path.join(buildDir, "preload.js"), "usesOwlAppShell:()=>E}; usesOwlAppShell:()=>E};");
    const config = path.join(root, "features.json");
    fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
    const report = createPatchReport();
    patchExtractedApp(root, { report, featuresConfigPath: config });
    const failure = enabledFeatureFailuresFromReport(report).find((entry) => entry.name.includes("preload-profile-bridge"));
    assert.equal(failure?.status, "skipped-optional");
    assert.match(failure?.reason ?? "", /found 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile menu adds Switch account below Log out and appends runtime once", () => {
  const fixture = "let T;T=l==null?null:(0,u7.jsx)(mI,{LeftIcon:$Kl,onClick:l,children:(0,u7.jsx)(Z,{id:`codex.profileDropdown.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`})});return (0,u7.jsxs)(`div`,{className:`flex w-full min-w-0 flex-col`,children:[v,y,o,b,h,S,i,w,T]})";
  const patched = applyProfileMenuPatch(fixture);
  assert.match(patched, new RegExp(MENU_MARKER));
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, /\(0,u7\.jsx\)\(mI,\{onClick:/);
  assert.match(patched, /children:\(0,u7\.jsx\)\(Z,\{id:`codex\.profileDropdown\.switchAccount`/);
  assert.doesNotMatch(patched, /\(0,l7\.jsx\)\(fI|LeftIcon:KGl/);
  assert.match(patched, /profile\.login/);
  assert.match(patched, /profile\.signedIn===false\?"Signed out"/);
  assert.match(patched, /active · signed out/);
  assert.match(patched, /profile\.removable&&api\.removeLinuxAccountProfile/);
  assert.match(patched, /remove\.textContent="×"/);
  assert.match(patched, /removeLinuxAccountProfile\(\{id:profile\.id\}\)/);
  assert.match(patched, /data-codex-linux-signed-out-switcher/);
  assert.match(patched, /button\.textContent="Switch account"/);
  assert.match(patched, /active\?\.signedIn===false&&state\.profiles\.length>1/);
  assert.match(patched, /setInterval\(codexLinuxSyncSignedOutSwitcher,2000\)/);
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

test("profile menu patch fails closed on duplicate semantic or container anchors", () => {
  const logout = "(0,u7.jsx)(mI,{LeftIcon:$Kl,onClick:l,children:(0,u7.jsx)(Z,{id:`codex.profileDropdown.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`})})";
  const container = "(0,u7.jsxs)(`div`,{className:`flex w-full min-w-0 flex-col`,children:[v,y,o,b,h,S,i,w,T]})";
  assert.equal(applyProfileMenuPatch(`${logout};${logout};${container}`), `${logout};${logout};${container}`);
  assert.equal(applyProfileMenuPatch(`${logout};${container};${container}`), `${logout};${container};${container}`);
});

test("account handoff quits through the launcher and waits for readiness", () => {
  const fixture = "l.ipcMain.handle(\"codex_linux_account_switcher\",async()=>null);";
  const patched = applyMainBundlePatch(fixture.replace(
    "l.ipcMain.handle",
    "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);l.ipcMain.handle",
  ));
  assert.match(patched, /codexLinuxAccountSwitcherKeepLocalProjectsThreads/);
  assert.match(patched, /if\(action==="list"\)\{\s+const details=registry\.profiles\.map/);
  assert.match(patched, /if\(action==="refresh"\)/);
  assert.match(patched, /codexLinuxAccountSwitcherCachedDetails/);
  assert.match(patched, /const signedIn=codexLinuxAccountSwitcherHasAuth\(profile\)/);
  assert.match(patched, /removable:profile\.id!=="default"&&!signedIn/);
  assert.match(patched, /action==="set-settings"/);
  assert.match(patched, /action==="remove"/);
  assert.match(patched, /The default account profile cannot be removed/);
  assert.match(patched, /Sign out before removing this account profile/);
  assert.match(patched, /Sign in to another account before removing the active profile/);
  assert.match(patched, /codexLinuxAccountSwitcherDeleteProfile\(profile\)/);
  assert.match(patched, /codexLinuxAccountSwitcherRelaunch\(target,profile,profile\.id\)/);
  assert.match(patched, /codexLinuxAccountSwitcherFinalizeRemoval/);
  assert.match(patched, /latest\.profiles=latest\.profiles\.filter\(\(entry\)=>entry\.id!==profile\.id\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWriteHandoff/);
  assert.match(patched, /l\.app\.quit\(\)/);
  assert.doesNotMatch(patched, /node:child_process/);
  assert.doesNotMatch(patched, /SIGTERM|SIGKILL|codexLinuxAccountSwitcherDescendantPids/);
});

test("removing an inactive signed-out profile deletes its exact managed root", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remove-inactive-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const dataHome = path.join(home, ".local", "share");
    const configDir = path.join(configHome, "codex-desktop");
    const profileRoot = path.join(dataHome, "codex-desktop", "account-profiles", "work");
    const resultPath = path.join(tempDir, "result.json");
    fs.mkdirSync(path.join(profileRoot, "electron"), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "sentinel"), "delete me");
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, profiles: [
      { id: "default", name: "Default", contextMode: "isolated", contextId: "default" },
      { id: "work", name: "Work", contextMode: "isolated", contextId: "default" },
    ] })}\n`);
    const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let handler;
const l={app:{whenReady:()=>Promise.resolve(),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setTimeout(async()=>{try{const value=await handler({sender:{},senderFrame:{}},{action:"remove",id:"work"});fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:true,value}));process.exit(0)}catch(error){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:error.message}));process.exit(1)}},50);
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE: "default" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.existsSync(profileRoot), false);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.deepEqual(registry.profiles.map((profile) => profile.id), ["default"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a removal completion marker repairs the registry after a crash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remove-recovery-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, previousProfileId: "work", profiles: [
      { id: "default", name: "Default", contextMode: "isolated", contextId: "default" },
      { id: "work", name: "Work", contextMode: "isolated", contextId: "default" },
    ] })}\n`);
    fs.writeFileSync(path.join(configDir, "account-switcher.remove-complete"), "work\n");
    const fixture = `
const V={isTrustedIpcSender:()=>true};
const l={app:{whenReady:()=>Promise.resolve(),once:()=>{}},ipcMain:{handle:()=>{}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setTimeout(()=>process.exit(0),100);
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.deepEqual(registry.profiles.map((profile) => profile.id), ["default"]);
    assert.equal(registry.previousProfileId, undefined);
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.remove-complete")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("logout falls back to the previous authenticated profile through the launcher handoff", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: true,
    fallbackAuth: true,
    removeActiveAuth: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "quit");
  assert.equal(outcome.active, "default\nisolated\ndefault\n");
  assert.match(outcome.handoff ?? "", /from_id=work/);
  assert.match(outcome.handoff ?? "", /target_id=default/);
  assert.equal(outcome.registry.previousProfileId, "work");
  assert.equal(outcome.registry.profiles.find((profile) => profile.id === "work").loginPendingUntil, undefined);
});

test("logout with no authenticated fallback keeps the login screen focused", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: true,
    fallbackAuth: false,
    removeActiveAuth: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "focus");
  assert.equal(outcome.active, "work\nisolated\ndefault\n");
  assert.equal(outcome.handoff, null);
});

test("cold restart repairs a logged-out active profile when another profile is authenticated", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: false,
    fallbackAuth: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "quit");
  assert.equal(outcome.active, "default\nisolated\ndefault\n");
  assert.match(outcome.handoff ?? "", /target_id=default/);
});

test("a newly selected logged-out profile keeps its bounded login window", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: false,
    fallbackAuth: true,
    loginPendingMs: 60_000,
    expectIdle: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "idle");
  assert.equal(outcome.active, "work\nisolated\ndefault\n");
  assert.equal(outcome.handoff, null);
});

test("an expired login-pending window falls back without a restart", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: false,
    fallbackAuth: true,
    loginPendingMs: 200,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "quit");
  assert.equal(outcome.active, "default\nisolated\ndefault\n");
  assert.match(outcome.handoff ?? "", /target_id=default/);
});

test("the first registry mutation creates its parent before acquiring the lock", () => {
  const patched = applyMainBundlePatch("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
  const functionStart = patched.indexOf("function codexLinuxAccountSwitcherWithLock");
  const parentCreate = patched.indexOf("mkdirSync(codexLinuxAccountSwitcherConfigDir", functionStart);
  const lockCreate = patched.indexOf("mkdirSync(lock", functionStart);
  assert.ok(functionStart >= 0);
  assert.ok(parentCreate > functionStart);
  assert.ok(lockCreate > parentCreate);
  assert.match(patched, /if\(error\?\.code!=="EEXIST"\)throw error/);
});

test("shared mode uses a generated context and never includes credential-bearing state", () => {
  const fixture = "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);";
  const patched = applyMainBundlePatch(fixture);
  assert.match(patched, /registry\.sharedContextId=\"shared-\"\+Date\.now\(\)\.toString\(36\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWriteActive\(active\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWithLock/);
  assert.doesNotMatch(patched, /shell_snapshots|session_index|codex-global-state/);
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

test("launcher recovers the real upstream default Electron profile after a cold restart", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-default-singletons-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const profileDir = path.join(configHome, "Codex");
    fs.mkdirSync(profileDir, { recursive: true });
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      fs.symlinkSync(name === "SingletonLock" ? "retired-container-999999" : path.join(tempDir, `missing-default-${name}`), path.join(profileDir, name));
    }

    const script = path.join(__dirname, "launcher-hook.sh");
    const env = { HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(home, ".local", "share") };
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      assert.throws(() => fs.lstatSync(path.join(profileDir, name)), { code: "ENOENT" });
    }
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
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "codex-desktop"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "codex-desktop", "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(target, "profile catalog");
    fs.writeFileSync(shared, "shared catalog");
    fs.writeFileSync(targetDev, "profile dev catalog");
    fs.writeFileSync(sharedDev, "shared dev catalog");
    fs.writeFileSync(path.join(profileHome, ".codex-global-state.json"), "profile project state");
    fs.mkdirSync(path.join(profileHome, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(profileHome, "sessions", "rollout.jsonl"), "profile rollout");
    fs.writeFileSync(path.join(profileHome, "session_index.jsonl"), "profile session index");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: {
        HOME: home,
        XDG_DATA_HOME: dataHome,
        CODEX_HOME: profileHome,
        CODEX_LINUX_APP_DIR: appDir,
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
    assert.equal(fs.existsSync(path.join(profileHome, ".codex-global-state.json")), true);
    assert.equal(fs.existsSync(path.join(profileHome, "sessions")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("after-exit handoff uses the launcher readiness protocol and rolls back failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    const launcher = path.join(appDir, "start.sh");
    fs.writeFileSync(launcher, "#!/bin/sh\nprintf '%s' \"$CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE\" > \"$HOME/started-profile\"\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    const hook = path.join(__dirname, "after-exit-hook.sh");
    const handoff = ["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=isolated", "target_context=default", "nonce=test"].join("\n") + "\n";
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir };
    const success = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(success.status, 0, `${success.stderr}\n${success.stdout}`);
    assert.equal(fs.readFileSync(path.join(home, "started-profile"), "utf8"), "work");
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);

    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const failed = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("active profile removal waits for replacement readiness and preserves rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remove-active-"));
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const profileRoot = path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    const launcher = path.join(appDir, "start.sh");
    const hook = path.join(__dirname, "after-exit-hook.sh");
    const handoff = ["version=1", "phase=requested", "from_id=work", "from_mode=isolated", "from_context=default", "target_id=default", "target_mode=isolated", "target_context=default", "remove_id=work", "nonce=test"].join("\n") + "\n";
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir };

    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "sentinel"), "delete me");
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(launcher, "#!/bin/sh\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    const success = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(success.status, 0, `${success.stderr}\n${success.stdout}`);
    assert.equal(fs.existsSync(profileRoot), false);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.remove-complete"), "utf8"), "work\n");

    fs.rmSync(path.join(configDir, "account-switcher.remove-complete"), { force: true });
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "sentinel"), "preserve me");
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const failed = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.equal(fs.readFileSync(path.join(profileRoot, "sentinel"), "utf8"), "preserve me");
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.remove-complete")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared migration refuses an active SQLite WAL handle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-wal-"));
  let fd;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const db = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db-wal");
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, "wal");
    fd = fs.openSync(db, "r");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: { HOME: home, XDG_DATA_HOME: dataHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SQLite path is open/);
  } finally {
    if (fd != null) fs.closeSync(fd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop deep-link handoff bypasses migration while the app is running", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-deep-link-"));
  let appProcess;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    const db = path.join(home, ".codex", "sqlite", "codex.db");
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, "open");
    const appPath = path.join(appDir, "ChatGPT");
    appProcess = spawn("bash", ["-c", `exec -a ${JSON.stringify(appPath)} sleep 30`]);
    const env = { HOME: home, XDG_DATA_HOME: dataHome, CODEX_LINUX_APP_DIR: appDir, CODEX_HOME: path.join(home, ".codex") };
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh"), "codex://auth/callback"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    appProcess?.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
