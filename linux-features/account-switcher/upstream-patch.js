"use strict";

const { createAccountSwitcher } = require("./runtime.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const MAIN_MARKER = "codexLinuxAccountSwitcherMain";

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function applyMain(source) {
  if (source.includes(MAIN_MARKER)) return source;
  const bridge = unique(source, new RegExp(
    `(case"mcp-request":\\{)${IDENT}\\(\\)\\.debug\\("app_server\\.bridge_received",\\{safe:\\{messageType:"mcp-request",requestId:String\\((${IDENT})\\.request\\.id\\),method:\\2\\.request\\.method,originWebcontentsId:(${IDENT})\\.id,originHostId:\\2\\.hostId`, "g"));
  const config = unique(source, new RegExp(
    `\\[\\.\\.\\.\\(0,${IDENT}\\.${IDENT}\\)\\((${IDENT})\\.globalState,\\1\\.hostConfig\\),` +
      `\\.\\.\\.await \\1\\.secretAuthStorageConfigOverrides,\\.\\.\\.await ` +
      `(?:${IDENT}\\(\\1\\)|async function\\(\\1\\)\\{(?=[\\s\\S]{0,1200}?plugins\\.codex-app-tools@openai-bundled\\.mcp_servers\\.codex_app\\.enabled=)[\\s\\S]{1,1200}?\\}\\(\\1\\))\\]`, "g"));
  if (!bridge || !config || !source.includes("sendAppServerResponseToView") || !source.includes("getAllHostIds")) {
    console.warn("WARN: Account switcher main-process contract drifted - skipping patch");
    return source;
  }
  const [, prefix, request, view] = bridge;
  const injected = `${prefix}/*${MAIN_MARKER}*/` +
    `if(${request}.request.method===\`community/accountSwitcher\`||this.codexLinuxAccountSwitcher?.isBusy()){` +
    `globalThis.codexLinuxUpstreamAccountSwitcherBusy=()=>true;` +
    `let response;try{if(globalThis.codexLinuxAccountSwitcherProfileBusy?.())throw Error(\`Profile change in progress.\`);if(globalThis.codexLinuxAccountSwitcherImplementation?.()!=="upstream")throw Error(\`Upstream account switching is disabled.\`);if(${request}.request.method!==\`community/accountSwitcher\`)throw Error(\`Account change in progress; retry shortly.\`);` +
    `let client=this.getAppServerConnection(${request}.hostId);if(client.hostConfig.kind!==\`local\`)throw Error(\`Account switching is only available on this computer.\`);` +
    `this.codexLinuxAccountSwitcher??=(${createAccountSwitcher.toString()})({` +
    `electron:require(\`electron\`),home:await client.codexHome(),` +
    `clients:()=>this.appServerConnectionRegistry.getAllHostIds().map(id=>this.getAppServerConnection(id))});` +
    `await this.codexLinuxAccountSwitcher.open(client,require(\`electron\`).BrowserWindow.fromWebContents(${view}),${request}.request.params?.locale);response={id:${request}.request.id,result:{}}` +
    `}catch{response={id:${request}.request.id,error:{code:-32000,message:\`Account switching is unavailable.\`}}}finally{globalThis.codexLinuxUpstreamAccountSwitcherBusy=()=>this.codexLinuxAccountSwitcher?.isBusy()===true}` +
    `this.sendAppServerResponseToView(${view},${request}.hostId,${request}.request.method,response,${request}.request.trace,${request}.priority);break}`;
  // Work backwards to keep indices stable. Both changes are one fail-closed contract.
  const edits = [
    { index: bridge.index, old: prefix, replacement: injected },
    { index: config.index, old: config[0], replacement: config[0].slice(0, -1) + `,...(${config[1]}.hostConfig.id===\`local\`?[\`cli_auth_credentials_store="file"\`,\`features.secret_auth_storage=false\`]:[])]` },
  ].sort((a, b) => b.index - a.index);
  for (const edit of edits) source = source.slice(0, edit.index) + edit.replacement + source.slice(edit.index + edit.old.length);
  return source;
}


module.exports = { applyMain };
