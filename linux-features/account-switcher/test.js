#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
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
  fs.copyFileSync(path.join(__dirname, "shared-state-json.js"), path.join(target, "shared-state-json.js"));
  fs.copyFileSync(path.join(__dirname, "shared-state-sqlite.js"), path.join(target, "shared-state-sqlite.js"));
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

test("a missing preload anchor is reported as enabled-feature drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-report-missing-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
    fs.writeFileSync(path.join(buildDir, "preload.js"), "const preloadBridge={unrelated:true};");
    const config = path.join(root, "features.json");
    fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
    const report = createPatchReport();
    patchExtractedApp(root, { report, featuresConfigPath: config });
    const failure = enabledFeatureFailuresFromReport(report).find((entry) => entry.name.includes("preload-profile-bridge"));
    assert.equal(failure?.status, "skipped-optional");
    assert.match(failure?.reason ?? "", /found 0/);
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

test("usage refresh returns the percentage persisted on the profile", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-usage-refresh-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const outputPath = path.join(tempDir, "result.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      profiles: [{
        id: "default",
        name: "Current account",
        usagePercent: 37,
        usageUpdatedAt: "2026-08-24T00:00:00.000Z",
      }],
    })}\n`);

    const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let handler=null;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{}},ipcMain:{handle:(name,value)=>{if(name==="codex_linux_account_switcher")handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{try{const result=await handler({sender:{}},{action:"refresh"});fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify(result));process.exit(0)}catch(error){console.error(error);process.exit(1)}});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const response = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(response.profiles[0].usagePercent, 37);
    assert.equal(response.profiles[0].usageUpdatedAt, "2026-08-24T00:00:00.000Z");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a late usage refresh does not overwrite a newer profile mutation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-refresh-race-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const codexHome = path.join(home, ".codex");
    const outputPath = path.join(tempDir, "result.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      profiles: [{ id: "default", name: "Current account", contextMode: "isolated", contextId: "default" }],
    })}\n`);
    fs.writeFileSync(path.join(codexHome, "auth.json"), `${JSON.stringify({
      tokens: { access_token: "fixture-token", account_id: "fixture-account" },
    })}\n`);

    const fixture = `
const fs=require("node:fs");
const {EventEmitter}=require("node:events");
const https=require("node:https");
https.request=(url,options,callback)=>{const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};request.end=()=>setTimeout(()=>{const response=new EventEmitter();response.statusCode=200;response.setEncoding=()=>{};callback(response);response.emit("data",JSON.stringify({email:"late@example.com",rate_limit:{primary_window:{used_percent:61}}}));response.emit("end")},100);return request};
const V={isTrustedIpcSender:()=>true};
let handler=null;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{}},ipcMain:{handle:(name,value)=>{if(name==="codex_linux_account_switcher")handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{try{const refresh=handler({sender:{}},{action:"refresh"});await new Promise(resolve=>setTimeout(resolve,20));await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:true});const result=await refresh;fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify(result));process.exit(0)}catch(error){console.error(error);process.exit(1)}});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.equal(registry.keepLocalProjectsThreads, true);
    assert.equal(registry.profiles[0].contextMode, "shared-local");
    assert.equal(registry.profiles[0].usagePercent, undefined);
    assert.equal(registry.profiles[0].email, undefined);
    const response = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(response.profiles[0].contextMode, "shared-local");
    assert.equal(response.profiles[0].usagePercent, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("JS and shell reject profile IDs outside the path-contained contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-profile-id-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "../escape\nisolated\ndefault\n", { mode: 0o600 });
    const shellResult = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], {
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      encoding: "utf8",
    });
    assert.equal(shellResult.status, 1);
    assert.match(shellResult.stderr, /refusing invalid profile id/);

    const patched = applyMainBundlePatch("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
    assert.match(patched, /const codexLinuxAccountSwitcherIdPattern=\/\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$\//);
    const sharedState = fs.readFileSync(path.join(__dirname, "shared-state.sh"), "utf8");
    assert.match(sharedState, /ACCOUNT_SWITCHER_ID_RE='\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$'/);
    const launcher = fs.readFileSync(path.join(__dirname, "launcher-hook.sh"), "utf8");
    assert.match(launcher, /account_switcher_validate_id "\$profile_id"/);
    assert.doesNotMatch(launcher, /\[a-z0-9\]\[a-z0-9\._-\]/);
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

    fs.unlinkSync(path.join(profileDir, "SingletonLock"));
    fs.unlinkSync(path.join(profileDir, "SingletonSocket"));
    const staleSocket = path.join(tempDir, "stale-singleton.sock");
    const socketResult = spawnSync("python3", ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", staleSocket], { encoding: "utf8" });
    assert.equal(socketResult.status, 0, socketResult.stderr);
    fs.symlinkSync("retired-container-999999", path.join(profileDir, "SingletonLock"));
    fs.symlinkSync(staleSocket, path.join(profileDir, "SingletonSocket"));
    fs.symlinkSync(path.join(tempDir, "stale-cookie"), path.join(profileDir, "SingletonCookie"));
    const staleSocketResult = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(staleSocketResult.status, 0, staleSocketResult.stderr);
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      assert.throws(() => fs.lstatSync(path.join(profileDir, name)), { code: "ENOENT" });
    }
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
    fs.writeFileSync(path.join(profileHome, ".codex-global-state.json"), JSON.stringify({ unrelated: "profile project state" }));
    fs.mkdirSync(path.join(profileHome, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(profileHome, "sessions", "rollout.jsonl"), "profile rollout");
    fs.writeFileSync(path.join(profileHome, "session_index.jsonl"), "profile session index");
    const sharedRoot = path.dirname(shared);
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sharedRoot, "sessions", "existing-rollout.jsonl"), "existing shared rollout");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "existing shared session index\n");
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileHome, ".codex-global-state.json"), "utf8")), { unrelated: "profile project state", "electron-persisted-atom-state": {} });
    assert.equal(fs.lstatSync(path.join(profileHome, "sessions")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(sharedRoot, "sessions", "rollout.jsonl"), "utf8"), "profile rollout");
    assert.equal(fs.readFileSync(path.join(sharedRoot, "sessions", "existing-rollout.jsonl"), "utf8"), "existing shared rollout");
    assert.equal(fs.statSync(path.join(profileHome, "sessions", "rollout.jsonl")).ino, fs.statSync(path.join(sharedRoot, "sessions", "rollout.jsonl")).ino);
    assert.equal(fs.lstatSync(path.join(profileHome, "session_index.jsonl")).isSymbolicLink(), false);
    assert.equal(fs.statSync(path.join(profileHome, "session_index.jsonl")).ino, fs.statSync(path.join(sharedRoot, "session_index.jsonl")).ino);
    assert.match(fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8"), /existing shared session index/);
    assert.match(fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8"), /profile session index/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared mode carries local project metadata without copying account-scoped state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-local-state-"));
  try {
    const source = path.join(tempDir, "source", ".codex-global-state.json");
    const target = path.join(tempDir, "target", ".codex-global-state.json");
    const shared = path.join(tempDir, "shared", "local-project-state.json");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, JSON.stringify({
      "local-projects": { project: { id: "project", name: "Shared project", rootPaths: ["/tmp/shared-project"] } },
      "project-order": ["project"],
      "thread-project-assignments": { thread: { projectKind: "local", projectId: "project" } },
      "electron-persisted-atom-state": {
        "thread-reference-capability:thread": true,
        "thread-client-id-v1:local%3Athread": "client-thread",
        "thread-descriptions-v1": { thread: "Shared thread" },
        "heartbeat-thread-permissions-by-id": { thread: "account-one-only" },
      },
      "account-scoped-value": "must-not-copy",
    }));
    fs.writeFileSync(target, JSON.stringify({
      unrelated: "account-two",
      "electron-persisted-atom-state": {
        "heartbeat-thread-permissions-by-id": { own: "account-two-only" },
      },
    }));
    const helper = path.join(__dirname, "shared-state-json.js");
    const result = spawnSync(process.execPath, [helper, "prepare", source, target, shared], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(merged.unrelated, "account-two");
    assert.deepEqual(merged["local-projects"], { project: { id: "project", name: "Shared project", rootPaths: ["/tmp/shared-project"] } });
    assert.deepEqual(merged["thread-project-assignments"], { thread: { projectKind: "local", projectId: "project" } });
    assert.equal(merged["electron-persisted-atom-state"]["thread-reference-capability:thread"], true);
    assert.equal(merged["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"].own, "account-two-only");
    assert.equal(merged["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"].thread, undefined);
    const sharedState = JSON.parse(fs.readFileSync(shared, "utf8"));
    assert.equal(sharedState["account-scoped-value"], undefined);
    assert.equal(sharedState.atom["heartbeat-thread-permissions-by-id"], undefined);
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

test("shared handoff merges source and target rollout files into an existing context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-session-merge-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(sourceHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(targetHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, "sessions", "source-rollout.jsonl"), "source rollout");
    fs.writeFileSync(path.join(targetHome, "sessions", "target-rollout.jsonl"), "target rollout");
    fs.writeFileSync(path.join(sharedRoot, "sessions", "existing-rollout.jsonl"), "existing rollout");
    fs.writeFileSync(path.join(sourceHome, "session_index.jsonl"), "source index\n");
    fs.writeFileSync(path.join(targetHome, "session_index.jsonl"), "target index\n");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "existing index\n");
    const staleSharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "old-team");
    const stateDb = new DatabaseSync(path.join(targetHome, "state_5.sqlite"));
    stateDb.exec("create table threads (id text primary key, rollout_path text not null)");
    stateDb.prepare("insert into threads (id, rollout_path) values (?, ?)").run("thread-path", `${sharedRoot}/sessions/source-rollout.jsonl`);
    stateDb.prepare("insert into threads (id, rollout_path) values (?, ?)").run("stale-thread-path", `${staleSharedRoot}/sessions/stale-rollout.jsonl`);
    stateDb.close();
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/sh\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), [
      "version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default",
      "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated",
      "target_previous_context=default", "nonce=test",
    ].join("\n") + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: sourceHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    for (const name of ["source-rollout.jsonl", "target-rollout.jsonl", "existing-rollout.jsonl"]) {
      assert.equal(fs.existsSync(path.join(sharedRoot, "sessions", name)), true);
    }
    const index = fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8");
    for (const line of ["source index", "target index", "existing index"]) assert.match(index, new RegExp(line));
    assert.equal(fs.lstatSync(path.join(sourceHome, "sessions")).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(targetHome, "sessions")).isSymbolicLink(), false);
    assert.equal(fs.statSync(path.join(targetHome, "sessions", "source-rollout.jsonl")).ino, fs.statSync(path.join(sharedRoot, "sessions", "source-rollout.jsonl")).ino);
    const rewrittenDb = new DatabaseSync(path.join(targetHome, "state_5.sqlite"));
    assert.equal(rewrittenDb.prepare("select rollout_path from threads where id = ?").get("thread-path").rollout_path, `${targetHome}/sessions/source-rollout.jsonl`);
    assert.equal(rewrittenDb.prepare("select rollout_path from threads where id = ?").get("stale-thread-path").rollout_path, `${targetHome}/sessions/stale-rollout.jsonl`);
    rewrittenDb.close();
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed migration restores the source selection and clears the handoff", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-migration-failure-"));
  let fd;
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const wal = path.join(home, ".codex", "sqlite", "codex.db-wal");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(wal), { recursive: true });
    fs.writeFileSync(wal, "active wal");
    fd = fs.openSync(wal, "r");
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      ["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated", "target_previous_context=default", "nonce=test"].join("\n") + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shared catalog migration failed; restored default/);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
  } finally {
    if (fd != null) fs.closeSync(fd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed shared handoff rolls back its prepared SQLite migration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-handoff-migration-rollback-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const source = path.join(home, ".codex", "sqlite", "codex.db");
    const target = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, "source catalog");
    fs.writeFileSync(target, "target catalog");
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/bash\nexit 17\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      ["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated", "target_previous_context=default", "nonce=test"].join("\n") + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(source, "utf8"), "source catalog");
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "target catalog");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.existsSync(shared), false);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isolated handoff detaches source and target from their previous shared context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-isolation-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    const source = path.join(home, ".codex", "sqlite", "codex.db");
    const target = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(shared, "shared catalog");
    const sharedRoot = path.dirname(shared);
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sharedRoot, "sessions", "rollout.jsonl"), "shared rollout");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "shared session index");
    fs.writeFileSync(`${source}.isolated-backup`, "source catalog");
    fs.writeFileSync(`${target}.isolated-backup`, "target catalog");
    fs.symlinkSync(shared, source);
    fs.symlinkSync(shared, target);
    fs.mkdirSync(path.join(home, ".codex", "sessions.isolated-backup"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "sessions.isolated-backup", "source.txt"), "source sessions");
    fs.mkdirSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions.isolated-backup"), { recursive: true });
    fs.writeFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions.isolated-backup", "target.txt"), "target sessions");
    fs.writeFileSync(path.join(home, ".codex", "session_index.jsonl.isolated-backup"), "source index");
    fs.writeFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "session_index.jsonl.isolated-backup"), "target index");
    fs.symlinkSync(path.join(sharedRoot, "sessions"), path.join(home, ".codex", "sessions"));
    fs.symlinkSync(path.join(sharedRoot, "sessions"), path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions"));
    fs.symlinkSync(path.join(sharedRoot, "session_index.jsonl"), path.join(home, ".codex", "session_index.jsonl"));
    fs.symlinkSync(path.join(sharedRoot, "session_index.jsonl"), path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "session_index.jsonl"));
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/bash\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      ["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=team", "target_id=work", "target_mode=isolated", "target_context=default", "target_previous_mode=shared-local", "target_previous_context=team", "nonce=test"].join("\n") + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(source, "utf8"), "source catalog");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "target catalog");
    assert.equal(fs.lstatSync(path.join(home, ".codex", "sessions")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(home, ".codex", "sessions", "source.txt"), "utf8"), "source sessions");
    assert.equal(fs.lstatSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions", "target.txt"), "utf8"), "target sessions");
    assert.equal(fs.readFileSync(path.join(home, ".codex", "session_index.jsonl"), "utf8"), "source index");
    assert.equal(fs.readFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "session_index.jsonl"), "utf8"), "target index");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppImage handoff composes through AppRun and waits for readiness", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-appimage-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const appDirRoot = path.join(tempDir, "appimage.AppDir");
    const appDir = path.join(appDirRoot, "opt", "codex-desktop");
    const configDir = path.join(home, ".config", "codex-desktop");
    const appImage = path.join(tempDir, "codex-desktop.AppImage");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    const appRun = fs.readFileSync(path.join(__dirname, "..", "..", "packaging", "appimage", "AppRun"), "utf8")
      .replaceAll("__PACKAGE_NAME__", "codex-desktop");
    fs.writeFileSync(path.join(appDirRoot, "AppRun"), appRun, { mode: 0o755 });
    fs.writeFileSync(appImage, "#!/bin/bash\nprintf invoked > \"$HOME/appimage-runtime\"\nexec \"$APPDIR/AppRun\" \"$@\"\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(appDir, "start.sh"),
      "#!/bin/bash\nprintf '%s\\n' \"$APPDIR\" > \"$HOME/appimage-launcher\"\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      ["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=isolated", "target_context=default", "nonce=test"].join("\n") + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: {
        ...process.env,
        APPDIR: appDirRoot,
        APPIMAGE: appImage,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_LINUX_APP_DIR: appDir,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.readFileSync(path.join(home, "appimage-runtime"), "utf8"), "invoked");
    assert.equal(fs.readFileSync(path.join(home, "appimage-launcher"), "utf8"), `${appDirRoot}\n`);
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
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

test("shared-context lock serializes migration recovery", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-context-lock-"));
  let holder;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const ready = path.join(tempDir, "lock-ready");
    const helper = path.join(__dirname, "shared-state.sh");
    const holderScript = `source ${JSON.stringify(helper)}; lock=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); : > ${JSON.stringify(ready)}; sleep 0.4; account_switcher_context_lock_release "$lock"`;
    holder = spawn("bash", ["-c", holderScript], { env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome } });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true);
    const startedAt = Date.now();
    const migration = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_migrate_shared ${JSON.stringify(path.join(home, ".codex"))} ${JSON.stringify(path.join(home, ".codex"))} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(migration.status, 0, migration.stderr);
    assert.ok(Date.now() - startedAt >= 250, "migration should wait for the live context owner");
    assert.equal(fs.existsSync(path.join(sharedRoot, ".account-switcher.lock")), false);
  } finally {
    holder?.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an abandoned migration journal is rolled back after a crash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-migration-crash-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const source = path.join(home, ".codex", "sqlite", "codex.db");
    const target = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const shared = path.join(sharedRoot, "codex.db");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, "source before crash");
    fs.writeFileSync(target, "target before crash");
    const crashed = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_prepare_shared ${JSON.stringify(path.join(home, ".codex"))} ${JSON.stringify(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex"))} team >/dev/null; exit 99`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(crashed.status, 99);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
    const recovered = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; lock=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); account_switcher_recover_context ${JSON.stringify(sharedRoot)}; account_switcher_context_lock_release "$lock"`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(source, "utf8"), "source before crash");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "target before crash");
    assert.equal(fs.existsSync(shared), false);
    assert.deepEqual(fs.readdirSync(sharedRoot).filter((name) => name.startsWith(".account-switcher-migration-")), []);
  } finally {
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
