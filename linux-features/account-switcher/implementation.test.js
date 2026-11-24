"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyMainBundlePatch, applyPreloadPatch, applyProfileMenuPatch, applyWebviewRuntimePatch, descriptors } = require("./patch.js");
const { applyMain } = require("./upstream-patch.js");
const { settingComponent, patchSettingsSource, settingsContract } = require("./settings.js");
const { findMainProcessChunks, findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { patchBreaksJavaScriptSyntax } = require("../../scripts/patches/lib/javascript-syntax.js");

function ipcHarness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-implementation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let handler;
  const electron = { app: {}, ipcMain: { handle: (_, callback) => { handler = callback; } } };
  const sandbox = {
    require: name => name === "electron" ? electron : require(name),
    process: { ...process, env: { PATH: process.env.PATH, HOME: home } },
    console, Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(applyMainBundlePatch("const V={isTrustedIpcSender:e=>e.trusted};let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);"), sandbox);
  return { sandbox, home, call: request => handler({ sender: { trusted: true } }, request),
    untrusted: request => handler({ sender: { trusted: false } }, request) };
}

test("implementation defaults to profiles, persists both choices, and rejects unsafe changes", async t => {
  const h = ipcHarness(t);
  assert.equal((await h.call({ action: "implementation" })).implementation, "profiles");
  await assert.rejects(h.untrusted({ action: "set-implementation", implementation: "upstream" }), /Untrusted/);
  await assert.rejects(h.call({ action: "set-implementation", implementation: "unknown" }), /Unknown/);
  const selecting = h.call({ action: "set-implementation", implementation: "upstream" });
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(h.call({ action: "set-implementation", implementation: "profiles" }), /finish/);
  await selecting;
  const file = path.join(h.home, ".config/codex-desktop/account-switcher.json");
  assert.equal(JSON.parse(fs.readFileSync(file)).implementation, "upstream");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(h.call({ action: "create", name: "must-not-create" }), /Profile switching is disabled/);
  h.sandbox.codexLinuxUpstreamAccountSwitcherBusy = () => true;
  await assert.rejects(h.call({ action: "set-implementation", implementation: "profiles" }), /finish/);
  h.sandbox.codexLinuxUpstreamAccountSwitcherBusy = () => false;
  await h.call({ action: "set-implementation", implementation: "profiles" });
  assert.equal(JSON.parse(fs.readFileSync(file)).implementation, "profiles");
  fs.writeFileSync(path.join(path.dirname(file), "account-switcher.handoff"), "pending");
  await assert.rejects(h.call({ action: "set-implementation", implementation: "upstream" }), /handoff/);
});

test("upstream bridge rejects calls unless selected and retains local credential isolation", async () => {
  const source = 'async function handle(view,message){switch(message.type){case"mcp-request":{log().debug("app_server.bridge_received",{safe:{messageType:"mcp-request",requestId:String(message.request.id),method:message.request.method,originWebcontentsId:view.id,originHostId:message.hostId}});this.sendAppServerResponseToView();this.appServerConnectionRegistry.getAllHostIds();break}}}async function config(options){return[...(0,helpers.computeConfig)(options.globalState,options.hostConfig),...await options.secretAuthStorageConfigOverrides,...await extras(options)]}';
  const patched = applyMain(source);
  assert.notEqual(patched, source);
  assert.equal(applyMain(patched), patched);
  assert.equal(applyMain(source + source), source + source);
  assert.match(patched, /hostConfig.id===`local`/);
  assert.match(patched, /features.secret_auth_storage=false/);
  const sandbox = { codexLinuxAccountSwitcherImplementation: () => "profiles" };
  const handle = vm.runInNewContext(patched + ";handle", sandbox);
  let response;
  await handle.call({ sendAppServerResponseToView: (_view, _host, _method, result) => { response = result; } }, {},
    { type: "mcp-request", hostId: "local", request: { id: "test", method: "community/accountSwitcher" } });
  assert.equal(response.error.code, -32000);
  assert.equal(sandbox.codexLinuxUpstreamAccountSwitcherBusy(), false);
  sandbox.codexLinuxAccountSwitcherImplementation = () => "upstream";
  sandbox.codexLinuxAccountSwitcherProfileBusy = () => true;
  response = null;
  await handle.call({ sendAppServerResponseToView: (_view, _host, _method, result) => { response = result; } }, {},
    { type: "mcp-request", hostId: "local", request: { id: "test", method: "community/accountSwitcher" } });
  assert.equal(response.error.code, -32000);
});

test("signed-out runtime routes upstream mode through the existing trusted message bridge", async () => {
  const source = 'const protocol="codex-host-chunked-message-v1";export{loader as __webpack_require__}';
  const runtime = applyWebviewRuntimePatch(source).slice(source.length);
  const sent = [];
  const sandbox = {
    window: { electronBridge: {
      getLinuxAccountSwitcherImplementation: async () => ({ implementation: "upstream" }),
      sendMessageFromView: async message => sent.push(message),
    } },
    document: { documentElement: { lang: "en" }, querySelector: () => null },
    setInterval() {}, console,
  };
  vm.runInNewContext(runtime, sandbox);
  await sandbox.window.codexLinuxOpenAccountSwitcher();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "mcp-request");
  assert.equal(sent[0].request.method, "community/accountSwitcher");
  assert.equal(sent[0].hostId, "local");
});

test("General toggle loads the saved implementation and saves both choices", async () => {
  let implementation = "profiles", index = 0, mounted = false;
  const values = [];
  const React = {
    useState: initial => { const slot = index++; if (!(slot in values)) values[slot] = initial; return [values[slot], value => { values[slot] = value; }]; },
    useEffect: effect => { if (!mounted) { mounted = true; effect(); } },
  };
  const sandbox = {
    React, platformHook: () => ({ platform: "linux" }), JSX: { jsx: (type, props) => ({ type, props }) },
    Row: "row", Toggle: "toggle", document: { querySelector: () => null },
    window: { electronBridge: {
      getLinuxAccountSwitcherImplementation: async () => ({ implementation }),
      setLinuxAccountSwitcherImplementation: async value => { implementation = value; return { implementation }; },
    } },
  };
  const render = vm.runInNewContext(settingComponent({ row: "Row", toggle: "Toggle", react: "React", platformHook: "platformHook", jsx: "JSX" }) + ";codexLinuxAccountSwitcherSetting", sandbox);
  const row = () => { index = 0; return render(); };
  assert.equal(row().props.entry.title.localizedText, "Use upstream account switcher");
  assert.equal(row().props.control.props.disabled, true);
  await Promise.resolve();
  assert.equal(row().props.control.props.checked, false);
  await row().props.control.props.onChange(true);
  assert.equal(implementation, "upstream");
  assert.equal(row().props.control.props.checked, true);
  await row().props.control.props.onChange(false);
  assert.equal(implementation, "profiles");
  assert.equal(row().props.control.props.checked, false);
});

test("General settings contract fails closed on drift", () => {
  assert.equal(settingsContract("changed settings"), null);
  assert.throws(() => patchSettingsSource("changed settings"), /missing or ambiguous/);
});

function settingsFixture() {
  return 'export const __rspack_esm_id=572868;export const __rspack_esm_ids=[572868];export const __webpack_modules__={G3wX:(function(e,t,a){a.d(t,{GeneralSettings:()=>page});' +
    'var n=a("ABep"),r=a("QosV"),m=a("zd8w"),P=a("AWNZ"),N=a("F0xz"),ed=a("ed00"),b=a("bb00"),F=a("RxZZ"),f=a("ff00");' +
    'function menu(e){let c=(0,r.c)(15),{appName:d}=e,h=(0,b.A)(),{platform:p}=(0,ed.V)(),x=1,v=(0,F.iK)(f.U6S.macMenuBarEnabled);if("macOS"!==p)return null;' +
    'let label=h.formatMessage({id:"settings.general.macMenuBar.ariaLabel"},{appName:d});let o=(0,n.jsx)(N.l,{checked:v,onChange:change,ariaLabel:label});' +
    'return(0,n.jsx)(P.ic,{entry:f.U6S.macMenuBarEnabled,description:d,control:o})}function change(){}function another(){let[e,t]=(0,m.useState)(!1)}' +
    'function page(){return(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(menu,{appName:"ChatGPT"}),(0,n.jsx)(N.l,{}),(0,n.jsx)(menu,{appName:f.C})]})}' +
    '/*settings.general.macMenuBar.description*/}),ABep(e,t,a){e.exports={}}};';
}

test("General setting patches both native layouts and is idempotent", () => {
  const source = settingsFixture();
  const patched = patchSettingsSource(source);
  assert.notEqual(patched, source);
  assert.equal(patchSettingsSource(patched), patched);
  assert.equal(patched.split("(0,n.jsx)(codexLinuxAccountSwitcherSetting,{})").length - 1, 2);
  new vm.Script(patched.replace(/export const /g, "const "));
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("both switching modes and their General toggle patch the signed bundle", { skip: !signedApp }, (t) => {
  const { buildDir, chunks } = findMainProcessChunks(signedApp);
  for (const apply of [applyMain, applyMainBundlePatch]) {
    const changes = [];
    for (const chunk of chunks) {
      const source = fs.readFileSync(path.join(buildDir, chunk), "utf8");
      const patched = apply(source);
      if (patched !== source) changes.push({ source, patched });
    }
    assert.equal(changes.length, 1, apply.name);
    const [{ source, patched }] = changes;
    assert.equal(apply(patched), patched);
    assert.equal(patchBreaksJavaScriptSyntax(source, patched), false);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-signed-preload-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const preload = path.join(temp, ".vite", "build", "preload.js");
  fs.mkdirSync(path.dirname(preload), { recursive: true });
  const originalPreload = fs.readFileSync(path.join(buildDir, "preload.js"), "utf8");
  fs.writeFileSync(preload, originalPreload);
  assert.deepEqual(applyPreloadPatch(temp), { matched: 1, changed: 1 });
  assert.deepEqual(applyPreloadPatch(temp), { matched: 1, changed: 0 });
  assert.equal(patchBreaksJavaScriptSyntax(originalPreload, fs.readFileSync(preload, "utf8")), false);

  const webview = path.join(signedApp, "webview");
  const indexHtml = fs.readFileSync(path.join(webview, "index.html"), "utf8");
  for (const { apply, assetNeedles, assetMatch } of [
    descriptors.find(({ id }) => id === "account-switcher-ui"),
    descriptors.find(({ id }) => id === "account-switcher-runtime"),
    { apply: patchSettingsSource, assetNeedles: ["settings.general.macMenuBar.description", ".macMenuBarEnabled"] },
  ]) {
    const candidates = findWebviewAssetsContaining(signedApp, assetNeedles)
      .map((name) => ({ name, source: fs.readFileSync(path.join(webview, "assets", name), "utf8") }))
      .filter(({ name, source }) => !assetMatch || assetMatch(source, name));
    assert.equal(candidates.length, 1, apply.name);
    const [{ name, source }] = candidates;
    const patched = apply(source);
    assert.notEqual(patched, source, apply.name);
    assert.equal(apply(patched), patched);
    assert.equal(patchBreaksJavaScriptSyntax(source, patched), false);
    if (apply === applyProfileMenuPatch) {
      assert.equal(patched.match(/codexLinuxAccountSwitcherRow\(/g)?.length, 3);
    } else if (apply === applyWebviewRuntimePatch) {
      assert.ok(indexHtml.includes(`src="/assets/${name}"`), "the desktop index loads the patched runtime");
    }
  }
});
