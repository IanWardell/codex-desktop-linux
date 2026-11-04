"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { patchBreaksJavaScriptSyntax } = require("../../scripts/patches/lib/javascript-syntax.js");

const ID = "[A-Za-z_$][\\w$]*";
const MEMBER = `${ID}(?:\\.${ID})*`;
const CALLEE = `(?:\\(0,${ID}\\.${ID}\\)|${ID})`;
const UI = "codexLinuxAccountSwitcherSetting";
const SETTINGS_NEEDLES = ["settings.general.macMenuBar.description", ".macMenuBarEnabled"];
const unique = (source, pattern) => {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
};

// rspack chunk: `export const __webpack_modules__={key(module,exports,require){…},…}`.
// Returns the module factory that contains `index`, so injected code shares
// that module's scope and captures only aliases declared by that factory.
function webpackFactory(source, index) {
  const head = "__webpack_modules__={";
  const start = source.indexOf(head);
  if (start < 0) return null;
  const entry = new RegExp(`(?:[\\w$]+|"(?:[^"\\\\]|\\\\.)*")\\((${ID}(?:,${ID}){0,2})?\\)\\{`, "y");
  let cursor = start + head.length;
  for (;;) {
    entry.lastIndex = cursor;
    const match = entry.exec(source);
    if (!match) return null;
    const open = entry.lastIndex - 1;
    const end = findMatchingBrace(source, open);
    if (end < 0) return null;
    if (index > open && index < end) return { open, end, params: (match[1] ?? "").split(",") };
    cursor = end + 1;
    if (source[cursor] !== ",") return null;
    cursor += 1;
  }
}

// Factory-scope alias bound to one required module, e.g. `m=a("zd8w")`.
function factoryImport(factory, requireName, alias) {
  const declarations = [...factory.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(alias)}=${escapeRegExp(requireName)}\\("([^"]+)"\\)`, "g"))];
  return declarations.length === 1 ? declarations[0][1] : null;
}

// Reuse the native General row, switch, locale hook, platform hook and React
// namespace. All aliases are captured from the current menu-bar setting and its
// own module factory, never from chunk or module ids.
function settingsContract(source) {
  const owner = unique(source, new RegExp(`function (${ID})\\((${ID})\\)\\{.{0,300}?\\{platform:(${ID})\\}=(${CALLEE})\\(\\),(${ID})=(${CALLEE})\\((${MEMBER})\\.macMenuBarEnabled\\);if\\("macOS"!==\\3\\)return null;`, "g"));
  if (!owner || !";{}".includes(source[owner.index - 1])) return null;
  const factory = webpackFactory(source, owner.index);
  const requireName = factory?.params[2];
  if (!requireName) return null;
  const factoryText = source.slice(factory.open, factory.end + 1);
  const end = findMatchingBrace(source, source.indexOf("{", owner.index));
  if (end < 0 || end > factory.end) return null;
  const body = source.slice(owner.index, end + 1);
  const row = unique(body, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${MEMBER}),\\{label:${ID},description:${ID},control:${ID}\\}`, "g"));
  const toggle = unique(body, new RegExp(`\\(0,${ID}\\.jsx\\)\\((${MEMBER}),\\{checked:${ID},onChange:${ID},ariaLabel:${ID}\\}`, "g"));
  const intlUse = unique(body, new RegExp(`(${ID})\\.formatMessage\\(\\{id:"settings\\.general\\.macMenuBar\\.ariaLabel"`, "g"));
  const intl = intlUse && unique(body, new RegExp(`(?<![\\w$.])${escapeRegExp(intlUse[1])}=(${CALLEE})\\(\\)`, "g"));
  if (!row || !toggle || !intl || !factoryImport(factoryText, requireName, row[1])) return null;
  const reactModules = new Map();
  for (const [, alias] of factoryText.matchAll(new RegExp(`\\(0,(${ID})\\.useState\\)\\(`, "g"))) {
    const id = factoryImport(factoryText, requireName, alias);
    if (id != null) reactModules.set(id, alias);
  }
  if (reactModules.size !== 1) return null;
  const renders = [...factoryText.matchAll(new RegExp(`\\(0,${escapeRegExp(row[1])}\\.jsx\\)\\(${escapeRegExp(owner[1])},\\{appName:(?:${MEMBER}|"[^"\\\\]*")\\}\\)`, "g"))]
    .map((match) => factory.open + match.index);
  if (renders.length === 0) return null;
  return {
    row: row[2], toggle: toggle[1], react: [...reactModules.values()][0], platformHook: owner[4], jsx: row[1],
    intlHook: intl[1], ownerEnd: end + 1, renders,
  };
}

function settingComponent({ row, toggle, react, platformHook, jsx }) {
  return `function ${UI}(){let {platform}=${platformHook}(),[enabled,setEnabled]=${react}.useState(false),[pending,setPending]=${react}.useState(true),[error,setError]=${react}.useState(null);${react}.useEffect(()=>{let live=true;window.electronBridge.getLinuxAccountSwitcherImplementation().then(state=>{if(live){setEnabled(state.implementation==="upstream");setPending(false)}}).catch(()=>{if(live)setError("Could not load account switcher preference")});return()=>{live=false}},[]);if(platform!=="linux")return null;let change=async value=>{if(pending)return;setPending(true);try{let state=await window.electronBridge.setLinuxAccountSwitcherImplementation(value===true?"upstream":"profiles");setEnabled(state.implementation==="upstream");setError(null);document.querySelector("[data-codex-linux-account-switcher]")?.remove()}catch{setError("Could not change switcher. Finish any account change and try again.")}finally{setPending(false)}};let label="Use upstream account switcher",description="Off: separate account profiles with optional shared history. On: encrypted saved logins sharing the current profile's chats and settings. Applies immediately; saved profiles remain available.";return(0,${jsx}.jsx)(${row},{label,description:error??description,control:(0,${jsx}.jsx)(${toggle},{checked:enabled,disabled:pending,onChange:change,ariaLabel:label})})}`;
}

function patchSettingsSource(source) {
  const contract = settingsContract(source);
  if (!contract) throw Error("account-switcher: native General setting contract missing or ambiguous");
  const component = settingComponent(contract);
  const render = `(0,${contract.jsx}.jsx)(${UI},{})`;
  if (source.includes(`function ${UI}(`)) {
    if (source.split(component).length !== 2 || source.split(render).length - 1 !== contract.renders.length) {
      throw Error("account-switcher: incomplete General setting patch");
    }
    return source;
  }
  const edits = [{ index: contract.ownerEnd, text: component }, ...contract.renders.map(index => ({ index, text: `${render},` }))]
    .sort((a, b) => b.index - a.index);
  let patched = source;
  for (const { index, text } of edits) patched = patched.slice(0, index) + text + patched.slice(index);
  if (patchBreaksJavaScriptSyntax(source, patched)) throw Error("account-switcher: General setting patch breaks JavaScript syntax");
  return patched;
}

function applySettingsPatch(extractedDir) {
  const candidates = findWebviewAssetsContaining(extractedDir, SETTINGS_NEEDLES);
  if (candidates.length !== 1) throw Error("account-switcher: General settings asset missing or ambiguous");
  const target = path.join(extractedDir, "webview/assets", candidates[0]);
  const source = fs.readFileSync(target, "utf8");
  const patched = patchSettingsSource(source);
  if (patched !== source) fs.writeFileSync(target, patched);
  return { changed: patched !== source };
}

module.exports = {
  settingsContract, settingComponent, patchSettingsSource, applySettingsPatch,
  settingsDescriptor: {
    id: "implementation-setting", phase: "extracted-app:post-webview", order: 29_130,
    ciPolicy: "opt-in", apply: applySettingsPatch,
  },
};
