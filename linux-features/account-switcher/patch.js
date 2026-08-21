"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  extractedAppPatch,
  mainBundlePatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");

const MAIN_MARKER = "codexLinuxAccountSwitcherIpcV1";
const PRELOAD_MARKER = "codexLinuxAccountSwitcherBridgeV1";
const MENU_MARKER = "codexLinuxAccountSwitcherProfileMenuV1";
const RUNTIME_MARKER = "codexLinuxAccountSwitcherRuntimeV1";

const MAIN_RUNTIME = String.raw`;/*${MAIN_MARKER}*/(function(){
const codexLinuxAccountSwitcherFs=require("node:fs");
const codexLinuxAccountSwitcherPath=require("node:path");
const codexLinuxAccountSwitcherOs=require("node:os");
const codexLinuxAccountSwitcherChildProcess=require("node:child_process");
const codexLinuxAccountSwitcherHttps=require("node:https");
const codexLinuxAccountSwitcherIpc="codex_linux_account_switcher";
const codexLinuxAccountSwitcherHome=process.env.HOME||codexLinuxAccountSwitcherOs.homedir();
const codexLinuxAccountSwitcherConfigHome=process.env.XDG_CONFIG_HOME||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherHome,".config");
const codexLinuxAccountSwitcherDataHome=process.env.XDG_DATA_HOME||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherHome,".local","share");
const codexLinuxAccountSwitcherConfigDir=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigHome,"codex-desktop");
const codexLinuxAccountSwitcherConfigPath=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"account-switcher.json");
const codexLinuxAccountSwitcherActivePath=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"account-switcher.active");
const codexLinuxAccountSwitcherBaseCodexHome=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME||process.env.CODEX_HOME||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherHome,".codex");
const codexLinuxAccountSwitcherBaseElectronUserDataPath=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_BASE_ELECTRON_USER_DATA_PATH||process.env.CODEX_ELECTRON_USER_DATA_PATH||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"electron");
function codexLinuxAccountSwitcherId(value){
  const id=typeof value==="string"?value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,""):"";
  return id.slice(0,64)||null;
}
function codexLinuxAccountSwitcherProfilePath(id){return codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherDataHome,"codex-desktop","account-profiles",id)}
function codexLinuxAccountSwitcherRead(){
  try{const value=JSON.parse(codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherConfigPath,"utf8"));if(value&&Array.isArray(value.profiles))return value}catch{}
  return {version:1,profiles:[]};
}
function codexLinuxAccountSwitcherWrite(value){
  codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherConfigDir,{recursive:true,mode:448});
  const temporary=codexLinuxAccountSwitcherConfigPath+".tmp."+process.pid;
  codexLinuxAccountSwitcherFs.writeFileSync(temporary,JSON.stringify(value,null,2)+"\n",{encoding:"utf8",mode:384});
  codexLinuxAccountSwitcherFs.renameSync(temporary,codexLinuxAccountSwitcherConfigPath);
}
function codexLinuxAccountSwitcherWriteActive(profile){
  codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherConfigDir,{recursive:true,mode:448});
  const temporary=codexLinuxAccountSwitcherActivePath+".tmp."+process.pid;
  codexLinuxAccountSwitcherFs.writeFileSync(temporary,[profile.id,profile.contextMode||"isolated",profile.contextId||"default"].join("\n")+"\n",{encoding:"utf8",mode:384});
  codexLinuxAccountSwitcherFs.renameSync(temporary,codexLinuxAccountSwitcherActivePath);
}
function codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry){
  if(typeof registry.keepLocalProjectsThreads==="boolean")return registry.keepLocalProjectsThreads;
  const activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",active=registry.profiles.find((entry)=>entry&&entry.id===activeId);
  return active?.contextMode==="shared-local";
}
function codexLinuxAccountSwitcherSetKeepLocalProjectsThreads(registry,enabled){
  const wasEnabled=codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry);
  registry.keepLocalProjectsThreads=enabled===true;
  if(registry.keepLocalProjectsThreads&&!wasEnabled)registry.sharedContextId="shared-"+Date.now().toString(36);
  const activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",active=registry.profiles.find((entry)=>entry&&entry.id===activeId);
  if(active){active.contextMode=registry.keepLocalProjectsThreads?"shared-local":"isolated";if(registry.keepLocalProjectsThreads)active.contextId=codexLinuxAccountSwitcherId(registry.sharedContextId)||"default"}
  return active||null;
}
function codexLinuxAccountSwitcherDefault(registry){
  let profile=registry.profiles.find((entry)=>entry&&entry.id==="default");
  if(profile==null){profile={id:"default",name:"Current account",contextMode:"isolated",contextId:"default",createdAt:new Date().toISOString()};registry.profiles.unshift(profile)}
  return profile;
}
function codexLinuxAccountSwitcherDecodeJwtPayload(token){
  try{const part=String(token||"").split(".")[1];if(!part)return null;return JSON.parse(Buffer.from(part.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"))}catch{return null}
}
function codexLinuxAccountSwitcherProfileCodexHome(profile){return profile.id==="default"?codexLinuxAccountSwitcherBaseCodexHome:codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherProfilePath(profile.id),"codex")}
function codexLinuxAccountSwitcherHasPath(value){try{codexLinuxAccountSwitcherFs.lstatSync(value);return true}catch{return false}}
function codexLinuxAccountSwitcherBackupPath(target){let backup=target+".isolated-backup",index=0;while(codexLinuxAccountSwitcherHasPath(backup))backup=target+".isolated-backup-"+(++index);return backup}
function codexLinuxAccountSwitcherLinkSharedCatalog(target,shared){
  codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherPath.dirname(target),{recursive:true,mode:448});
  if(codexLinuxAccountSwitcherHasPath(target)){
    const stat=codexLinuxAccountSwitcherFs.lstatSync(target);
    if(stat.isSymbolicLink()){
      const link=codexLinuxAccountSwitcherFs.readlinkSync(target);
      if(link===shared)return;
      const source=codexLinuxAccountSwitcherPath.resolve(codexLinuxAccountSwitcherPath.dirname(target),link),managedRoot=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherDataHome,"codex-desktop","account-contexts");
      if(source!==managedRoot&&!source.startsWith(managedRoot+codexLinuxAccountSwitcherPath.sep))throw Error("Account catalog points outside the managed shared contexts");
      if(!codexLinuxAccountSwitcherHasPath(shared)&&codexLinuxAccountSwitcherHasPath(source)){const sourceStat=codexLinuxAccountSwitcherFs.statSync(source);if(sourceStat.isDirectory())codexLinuxAccountSwitcherFs.cpSync(source,shared,{recursive:true});else codexLinuxAccountSwitcherFs.copyFileSync(source,shared)}
      codexLinuxAccountSwitcherFs.unlinkSync(target);
      if(codexLinuxAccountSwitcherHasPath(shared))codexLinuxAccountSwitcherFs.symlinkSync(shared,target);
      return;
    }
    if(codexLinuxAccountSwitcherHasPath(shared))codexLinuxAccountSwitcherFs.renameSync(target,codexLinuxAccountSwitcherBackupPath(target));
    else codexLinuxAccountSwitcherFs.renameSync(target,shared);
  }
  if(codexLinuxAccountSwitcherHasPath(shared)&&!codexLinuxAccountSwitcherHasPath(target))codexLinuxAccountSwitcherFs.symlinkSync(shared,target);
}
function codexLinuxAccountSwitcherPrepareSharedContext(profile){
  if(profile.contextMode!=="shared-local")return;
  const contextId=codexLinuxAccountSwitcherId(profile.contextId)||"default",sharedRoot=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherDataHome,"codex-desktop","account-contexts",contextId),sharedBase=codexLinuxAccountSwitcherPath.join(sharedRoot,"codex.db"),activeHome=process.env.CODEX_HOME||codexLinuxAccountSwitcherBaseCodexHome,targetHome=codexLinuxAccountSwitcherProfileCodexHome(profile);
  codexLinuxAccountSwitcherFs.mkdirSync(sharedRoot,{recursive:true,mode:448});
  for(const catalogName of ["codex.db","codex-dev.db","codex-thread-summaries.db","codex-thread-summaries-dev.db"]){for(const suffix of ["","-wal","-shm"]){const shared=codexLinuxAccountSwitcherPath.join(sharedRoot,catalogName+suffix);codexLinuxAccountSwitcherLinkSharedCatalog(codexLinuxAccountSwitcherPath.join(activeHome,"sqlite",catalogName+suffix),shared);codexLinuxAccountSwitcherLinkSharedCatalog(codexLinuxAccountSwitcherPath.join(targetHome,"sqlite",catalogName+suffix),shared)}}
  for(const suffix of ["",".bak"]){const shared=codexLinuxAccountSwitcherPath.join(sharedRoot,"codex-global-state.json"+suffix);codexLinuxAccountSwitcherLinkSharedCatalog(codexLinuxAccountSwitcherPath.join(activeHome,".codex-global-state.json"+suffix),shared);codexLinuxAccountSwitcherLinkSharedCatalog(codexLinuxAccountSwitcherPath.join(targetHome,".codex-global-state.json"+suffix),shared)}
  for(const name of ["sessions","session_index.jsonl","shell_snapshots"]){const shared=codexLinuxAccountSwitcherPath.join(sharedRoot,name);codexLinuxAccountSwitcherLinkSharedCatalog(codexLinuxAccountSwitcherPath.join(activeHome,name),shared);codexLinuxAccountSwitcherLinkSharedCatalog(codexLinuxAccountSwitcherPath.join(targetHome,name),shared)}
}
function codexLinuxAccountSwitcherRestoreIsolatedPath(target,shared){
  if(!codexLinuxAccountSwitcherHasPath(target))return;
  const stat=codexLinuxAccountSwitcherFs.lstatSync(target);
  if(!stat.isSymbolicLink()||codexLinuxAccountSwitcherFs.readlinkSync(target)!==shared)return;
  codexLinuxAccountSwitcherFs.unlinkSync(target);
  let backup=target+".isolated-backup",index=0;
  while(!codexLinuxAccountSwitcherHasPath(backup)&&index<100){if(index>0)backup=target+".isolated-backup-"+index;index++}
  if(codexLinuxAccountSwitcherHasPath(backup))codexLinuxAccountSwitcherFs.renameSync(backup,target);
}
function codexLinuxAccountSwitcherPrepareIsolatedContext(profile){
  const contextId=codexLinuxAccountSwitcherId(profile.contextId)||"default",sharedRoot=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherDataHome,"codex-desktop","account-contexts",contextId),targetHome=codexLinuxAccountSwitcherProfileCodexHome(profile);
  for(const catalogName of ["codex.db","codex-dev.db","codex-thread-summaries.db","codex-thread-summaries-dev.db"]){for(const suffix of ["","-wal","-shm"]){codexLinuxAccountSwitcherRestoreIsolatedPath(codexLinuxAccountSwitcherPath.join(targetHome,"sqlite",catalogName+suffix),codexLinuxAccountSwitcherPath.join(sharedRoot,catalogName+suffix))}}
  for(const suffix of ["",".bak"]){codexLinuxAccountSwitcherRestoreIsolatedPath(codexLinuxAccountSwitcherPath.join(targetHome,".codex-global-state.json"+suffix),codexLinuxAccountSwitcherPath.join(sharedRoot,"codex-global-state.json"+suffix))}
  for(const name of ["sessions","session_index.jsonl","shell_snapshots"]){codexLinuxAccountSwitcherRestoreIsolatedPath(codexLinuxAccountSwitcherPath.join(targetHome,name),codexLinuxAccountSwitcherPath.join(sharedRoot,name))}
}
function codexLinuxAccountSwitcherReadAuth(profile){
  try{return JSON.parse(codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherProfileCodexHome(profile),"auth.json"),"utf8"))}catch{return null}
}
function codexLinuxAccountSwitcherUsage(accessToken,accountId){
  return new Promise((resolve)=>{
    if(typeof accessToken!=="string"||accessToken.length===0){resolve(null);return}
    const request=codexLinuxAccountSwitcherHttps.request("https://chatgpt.com/backend-api/wham/usage",{method:"GET",headers:{Authorization:"Bearer "+accessToken,"chatgpt-account-id":typeof accountId==="string"?accountId:"","OAI-App-Brand":"codex"}},(response)=>{
      let body="";response.setEncoding("utf8");response.on("data",(chunk)=>{if(body.length<1048576)body+=chunk});response.on("end",()=>{try{if(response.statusCode<200||response.statusCode>=300){resolve(null);return}const value=JSON.parse(body),percent=value?.rate_limit?.primary_window?.used_percent,email=typeof value?.email==="string"?value.email.trim():null;resolve({email:email||null,usagePercent:Number.isFinite(percent)?Math.max(0,Math.min(100,Math.round(percent))):null})}catch{resolve(null)}})
    });
    request.setTimeout(5000,()=>{request.destroy();resolve(null)});request.on("error",()=>resolve(null));request.end();
  })
}
function codexLinuxAccountSwitcherCachedDetails(profile){
  const auth=codexLinuxAccountSwitcherReadAuth(profile),tokens=auth?.tokens||{},claims=codexLinuxAccountSwitcherDecodeJwtPayload(tokens.id_token),cachedEmail=typeof profile.email==="string"?profile.email:null,cachedUsage=Number.isFinite(profile.usagePercent)?profile.usagePercent:null;
  return{email:cachedEmail|| (typeof claims?.email==="string"?claims.email:null),usagePercent:cachedUsage,usageUpdatedAt:typeof profile.usageUpdatedAt==="string"?profile.usageUpdatedAt:null,tokens};
}
async function codexLinuxAccountSwitcherDetails(profile){
  const fallback=codexLinuxAccountSwitcherCachedDetails(profile),tokens=fallback.tokens;
  const live=await codexLinuxAccountSwitcherUsage(tokens.access_token,tokens.account_id);
  if(live==null)return fallback;
  return{email:live.email||fallback.email,usagePercent:live.usagePercent==null?fallback.usagePercent:live.usagePercent,usageUpdatedAt:live.usagePercent==null?fallback.usageUpdatedAt:new Date().toISOString()}
}
function codexLinuxAccountSwitcherPublic(profile,details={}){return{id:profile.id,name:profile.name,login:details.email||profile.email||null,usagePercent:Number.isFinite(details.usagePercent)?details.usagePercent:null,usageUpdatedAt:details.usageUpdatedAt||profile.usageUpdatedAt||null,contextMode:profile.contextMode||"isolated",contextId:profile.contextId||"default"}}
function codexLinuxAccountSwitcherFind(registry,id){const profile=registry.profiles.find((entry)=>entry&&entry.id===id);if(profile==null)throw Error("Unknown account profile");return profile}
function codexLinuxAccountSwitcherEnvironment(profile){
  const environment={...process.env};
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME=codexLinuxAccountSwitcherBaseCodexHome;
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_BASE_ELECTRON_USER_DATA_PATH=codexLinuxAccountSwitcherBaseElectronUserDataPath;
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=profile.id;
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=profile.contextMode||"isolated";
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=profile.contextId||"default";
  if(profile.id==="default"){environment.CODEX_HOME=codexLinuxAccountSwitcherBaseCodexHome;environment.CODEX_ELECTRON_USER_DATA_PATH=codexLinuxAccountSwitcherBaseElectronUserDataPath}else{const root=codexLinuxAccountSwitcherProfilePath(profile.id);codexLinuxAccountSwitcherFs.mkdirSync(root,{recursive:true,mode:448});environment.CODEX_HOME=codexLinuxAccountSwitcherPath.join(root,"codex");environment.CODEX_ELECTRON_USER_DATA_PATH=codexLinuxAccountSwitcherPath.join(root,"electron")}
  return environment;
}
function codexLinuxAccountSwitcherDescendantPids(parentPid){
  const children=new Map();
  try{for(const entry of codexLinuxAccountSwitcherFs.readdirSync("/proc")){if(!/^\d+$/.test(entry))continue;try{const status=codexLinuxAccountSwitcherFs.readFileSync("/proc/"+entry+"/status","utf8"),match=/^PPid:\s+(\d+)$/m.exec(status);if(!match)continue;const ppid=Number(match[1]),pid=Number(entry),list=children.get(ppid)||[];list.push(pid);children.set(ppid,list)}catch{}}}catch{return[]}
  const descendants=[],pending=[parentPid];
  while(pending.length){const parent=pending.pop();for(const pid of children.get(parent)||[]){descendants.push(pid);pending.push(pid)}}
  return descendants.reverse();
}
function codexLinuxAccountSwitcherStopOldDescendants(pids){
  for(const signal of ["SIGTERM","SIGKILL"]){for(const pid of pids){try{process.kill(pid,signal)}catch{}}if(signal==="SIGTERM"&&pids.length){try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150)}catch{}}}
}
function codexLinuxAccountSwitcherProcessOwnsProfile(userDataDir){
  const argument="--user-data-dir="+userDataDir;
  try{for(const entry of codexLinuxAccountSwitcherFs.readdirSync("/proc")){if(!/^\d+$/.test(entry))continue;try{if(codexLinuxAccountSwitcherFs.readFileSync("/proc/"+entry+"/cmdline","utf8").split("\0").includes(argument))return true}catch{}}}catch{}
  return false;
}
function codexLinuxAccountSwitcherClearStaleSingletons(userDataDir){
  const lock=codexLinuxAccountSwitcherPath.join(userDataDir,"SingletonLock"),socket=codexLinuxAccountSwitcherPath.join(userDataDir,"SingletonSocket");
  try{if(!codexLinuxAccountSwitcherFs.lstatSync(lock).isSymbolicLink())return}catch{return}
  if(codexLinuxAccountSwitcherProcessOwnsProfile(userDataDir))return;
  try{const match=/^(.+)-(\d+)$/.exec(codexLinuxAccountSwitcherFs.readlinkSync(lock));if(match&&match[1]===codexLinuxAccountSwitcherOs.hostname()){try{process.kill(Number(match[2]),0);return}catch(errorValue){if(errorValue?.code!=="ESRCH")return}}}catch{return}
  try{if(codexLinuxAccountSwitcherFs.lstatSync(socket).isSymbolicLink()){const link=codexLinuxAccountSwitcherFs.readlinkSync(socket),target=codexLinuxAccountSwitcherPath.resolve(userDataDir,link);if(codexLinuxAccountSwitcherFs.statSync(target).isSocket())return}}catch{}
  for(const name of ["SingletonLock","SingletonSocket","SingletonCookie"]){const target=codexLinuxAccountSwitcherPath.join(userDataDir,name);try{if(codexLinuxAccountSwitcherFs.lstatSync(target).isSymbolicLink())codexLinuxAccountSwitcherFs.unlinkSync(target)}catch{}}
}
function codexLinuxAccountSwitcherRelaunch(profile){
  if(profile.contextMode==="shared-local")codexLinuxAccountSwitcherPrepareSharedContext(profile);else codexLinuxAccountSwitcherPrepareIsolatedContext(profile);
  codexLinuxAccountSwitcherWriteActive(profile);
  const args=[];
  for(let index=1;index<process.argv.length;index++){const argument=process.argv[index];if(argument==="--user-data-dir"){index++;continue}if(typeof argument==="string"&&argument.startsWith("--user-data-dir="))continue;args.push(argument)}
  const userDataDir=profile.id==="default"?codexLinuxAccountSwitcherBaseElectronUserDataPath:codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherProfilePath(profile.id),"electron");
  codexLinuxAccountSwitcherClearStaleSingletons(userDataDir);
  args.push("--user-data-dir="+userDataDir);
  const oldDescendants=codexLinuxAccountSwitcherDescendantPids(process.pid);
  const child=codexLinuxAccountSwitcherChildProcess.spawn(process.execPath,args,{env:codexLinuxAccountSwitcherEnvironment(profile),detached:true,stdio:"ignore"});
  child.unref();
  // app.quit() is cooperative: upstream windows or before-quit handlers can
  // keep the old Electron instance alive while the replacement is starting.
  // That is especially harmful during repeated account switches because each
  // instance owns a full renderer/app-server process tree. The registry and
  // active-profile state are synchronously persisted above, so force the old
  // instance out once the replacement process has been spawned.
  codexLinuxAccountSwitcherStopOldDescendants(oldDescendants);
  try{l.app.exit(0)}catch{try{l.app.quit()}catch{}}
  return{ok:true,restarting:true,profile:codexLinuxAccountSwitcherPublic(profile)};
}
l.ipcMain.handle(codexLinuxAccountSwitcherIpc,async(codexLinuxAccountSwitcherEvent,request={})=>{
  if(!be(codexLinuxAccountSwitcherEvent))throw Error("Untrusted account-switcher IPC sender");
  const action=typeof request.action==="string"?request.action:"list";
  const registry=codexLinuxAccountSwitcherRead();
  codexLinuxAccountSwitcherDefault(registry);
  if(action==="list"){
    const details=registry.profiles.map((profile)=>codexLinuxAccountSwitcherCachedDetails(profile));
    return{profiles:registry.profiles.map((profile,index)=>codexLinuxAccountSwitcherPublic(profile,details[index])),activeProfileId:process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",keepLocalProjectsThreads:codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry)}
  }
  if(action==="refresh"){
    const details=await Promise.all(registry.profiles.map((profile)=>codexLinuxAccountSwitcherDetails(profile))),now=new Date().toISOString();
    details.forEach((value,index)=>{const profile=registry.profiles[index];if(value.email&&profile.email!==value.email){profile.email=value.email}if(value.usagePercent!=null&&(profile.usagePercent!==value.usagePercent||profile.usageUpdatedAt==null)){profile.usagePercent=value.usagePercent;profile.usageUpdatedAt=value.usageUpdatedAt||now}});
    codexLinuxAccountSwitcherWrite(registry);return{profiles:registry.profiles.map((profile,index)=>codexLinuxAccountSwitcherPublic(profile,details[index])),activeProfileId:process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",keepLocalProjectsThreads:codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry)}
  }
  if(action==="set-settings"){
    const active=codexLinuxAccountSwitcherSetKeepLocalProjectsThreads(registry,request.keepLocalProjectsThreads===true);
    codexLinuxAccountSwitcherWrite(registry);
    if(active)codexLinuxAccountSwitcherWriteActive(active);
    return{ok:true,keepLocalProjectsThreads:codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry)};
  }
  if(action==="create"){
    const name=typeof request.name==="string"?request.name.trim():"";
    const id=codexLinuxAccountSwitcherId(request.id||name);
    if(!id)throw Error("Account name is required");
    if(registry.profiles.some((entry)=>entry.id===id))throw Error("An account profile with that name already exists");
    const profile={id,name:name||id,contextMode:"isolated",contextId:"default",createdAt:new Date().toISOString()};
    registry.profiles.push(profile);codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherProfilePath(id),{recursive:true,mode:448});codexLinuxAccountSwitcherWrite(registry);return{profile:codexLinuxAccountSwitcherPublic(profile)};
  }
  if(action==="switch"){
    const profile=codexLinuxAccountSwitcherFind(registry,codexLinuxAccountSwitcherId(request.id));
    if(request.contextMode!=null){if(request.contextMode!=="isolated"&&request.contextMode!=="shared-local")throw Error("Unknown account context mode");codexLinuxAccountSwitcherSetKeepLocalProjectsThreads(registry,request.contextMode==="shared-local")}
    profile.contextMode=codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry)?"shared-local":"isolated";if(profile.contextMode==="shared-local")profile.contextId=codexLinuxAccountSwitcherId(registry.sharedContextId)||"default";codexLinuxAccountSwitcherWrite(registry);
    return codexLinuxAccountSwitcherRelaunch(profile);
  }
  throw Error("Unknown account-switcher action");
});
})();`;

const WEBVIEW_RUNTIME = String.raw`;/*${RUNTIME_MARKER}*/(()=>{
if(window.__codexLinuxAccountSwitcherRuntime)return;
window.__codexLinuxAccountSwitcherRuntime=true;
window.codexLinuxOpenAccountSwitcher=()=>{
  const api=window.electronBridge;
  if(!api?.getLinuxAccountProfiles)return;
  let overlay=document.querySelector("[data-codex-linux-account-switcher]");
  if(!overlay){
    overlay=document.createElement("div");overlay.dataset.codexLinuxAccountSwitcher="true";
    overlay.innerHTML="<style>[data-codex-linux-account-switcher]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:13px/1.35 system-ui,sans-serif;color:var(--text-primary,#fff)}.als-card{width:360px;max-width:calc(100vw - 32px);border:1px solid var(--border-medium,rgba(255,255,255,.16));border-radius:14px;background:var(--surface-primary,#242424);box-shadow:0 18px 60px rgba(0,0,0,.45);padding:18px}.als-title{font-size:16px;font-weight:650}.als-copy{color:var(--text-secondary,#aaa);font-size:12px;margin:4px 0 14px}.als-list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}.als-account,.als-close,.als-add{border:0;border-radius:8px;padding:9px 10px;background:transparent;color:inherit;text-align:left;cursor:pointer}.als-account:hover,.als-close:hover{background:rgba(255,255,255,.1)}.als-account{display:flex;align-items:center;gap:8px}.als-account-active{background:rgba(255,255,255,.12)}.als-dot{width:7px;height:7px;border-radius:50%;background:#6ee7b7}.als-details{display:flex;flex:1;min-width:0;flex-direction:column}.als-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.als-meta{color:var(--text-secondary,#aaa);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.als-badge{color:var(--text-secondary,#aaa);font-size:11px}.als-rule{height:1px;background:rgba(255,255,255,.12);margin:12px 0}.als-form{display:flex;gap:6px}.als-input{min-width:0;flex:1;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:transparent;color:inherit;padding:8px}.als-add{background:#fff;color:#111;text-align:center}.als-mode{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--text-secondary,#bbb);font-size:11px;cursor:pointer}.als-mode input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.als-switch{position:relative;flex:none;width:30px;height:17px;border-radius:10px;background:#666;transition:background .15s ease}.als-switch::after{content:\"\";position:absolute;top:3px;left:3px;width:11px;height:11px;border-radius:50%;background:#ddd;transition:transform .15s ease}.als-mode input:checked+.als-switch{background:#6ee7b7}.als-mode input:checked+.als-switch::after{transform:translateX(13px);background:#132a24}.als-mode-copy{flex:1}.als-mode-state{min-width:22px;color:var(--text-secondary,#aaa);text-align:right}.als-actions{display:flex;justify-content:flex-end;margin-top:12px}.als-error{color:#ff9b9b;font-size:11px;margin-top:7px}</style><div class=als-card role=dialog aria-modal=true><div class=als-title>Switch account</div><div class=als-copy>Choose a saved profile. Switching relaunches Codex without logging out or deleting profile data.</div><div class=als-list></div><div class=als-rule></div><form class=als-form><input class=als-input maxlength=64 placeholder=\"Add account name\"/><button class=als-add type=submit>Add</button></form><label class=als-mode><input type=checkbox aria-label=\"Keep local projects and threads\"/><span class=als-switch aria-hidden=true></span><span class=als-mode-copy>Keep the local projects/thread catalog</span><span class=als-mode-state>Off</span></label><div class=als-error aria-live=polite></div><div class=als-actions><button class=als-close type=button>Close</button></div></div>";
    document.body.append(overlay);
    overlay.querySelector(".als-close").onclick=()=>overlay.remove();
    overlay.addEventListener("click",(event)=>{if(event.target===overlay)overlay.remove()});
    overlay.querySelector("form").onsubmit=async(event)=>{event.preventDefault();const input=overlay.querySelector(".als-input"),name=input.value.trim();if(!name)return;try{const result=await api.createLinuxAccountProfile({name});await api.switchLinuxAccountProfile({id:result.profile.id,contextMode:overlay.querySelector(".als-mode input").checked?"shared-local":"isolated",contextId:"default"})}catch(error){overlay.querySelector(".als-error").textContent=error?.message||String(error)}};
  }
  const list=overlay.querySelector(".als-list"),error=overlay.querySelector(".als-error"),shared=overlay.querySelector(".als-mode input"),sharedState=overlay.querySelector(".als-mode-state"),syncSharedState=()=>{sharedState.textContent=shared.checked?"On":"Off"};
  const persistSharedState=async()=>{const requested=shared.checked;syncSharedState();try{await api.setLinuxAccountSwitcherSettings({keepLocalProjectsThreads:requested})}catch(errorValue){shared.checked=!requested;syncSharedState();error.textContent=errorValue?.message||String(errorValue)}};
  shared.onchange=persistSharedState;syncSharedState();
  list.replaceChildren();error.textContent="";
  const rows=new Map(),updateProfileRow=(button,profile)=>{const name=button.querySelector(".als-name"),meta=button.querySelector(".als-meta"),nextName=profile.login||profile.name||profile.id,nextMeta=Number.isFinite(profile.usagePercent)?"Usage: "+profile.usagePercent+"% used":"Usage: unavailable";if(name.textContent!==nextName)name.textContent=nextName;if(meta.textContent!==nextMeta)meta.textContent=nextMeta};
  const cachedRequest=api.getLinuxAccountProfiles(),refreshRequest=api.refreshLinuxAccountProfiles?.();
  cachedRequest.then((state)=>{if(!overlay.isConnected)return;shared.checked=state.keepLocalProjectsThreads===true;syncSharedState();for(const profile of state.profiles){const button=document.createElement("button");button.type="button";button.className="als-account"+(profile.id===state.activeProfileId?" als-account-active":"");button.innerHTML="<span class=als-dot></span><span class=als-details><span class=als-name></span><span class=als-meta></span></span><span class=als-badge></span>";updateProfileRow(button,profile);button.querySelector(".als-badge").textContent=profile.id===state.activeProfileId?"active":"switch";button.onclick=async()=>{if(profile.id===state.activeProfileId)return;button.disabled=true;try{await api.switchLinuxAccountProfile({id:profile.id,contextMode:shared.checked?"shared-local":"isolated",contextId:"default"})}catch(errorValue){button.disabled=false;error.textContent=errorValue?.message||String(errorValue)}};rows.set(profile.id,button);list.append(button)}}).catch((errorValue)=>{error.textContent=errorValue?.message||String(errorValue)});
  if(refreshRequest)refreshRequest.then((state)=>cachedRequest.then(()=>{if(!overlay.isConnected)return;for(const profile of state.profiles){const button=rows.get(profile.id);if(button)updateProfileRow(button,profile)}})).catch(()=>{});
};
})();`;

function replaceOnce(source, needle, replacement, description) {
  const count = source.split(needle).length - 1;
  if (count === 1) return source.replace(needle, replacement);
  console.warn(`WARN: Expected one ${description}, found ${count} - skipping account-switcher patch`);
  return source;
}

function applyMainBundlePatch(source) {
  if (source.includes(MAIN_MARKER)) return source;
  const needle = "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);";
  return replaceOnce(source, needle, needle + MAIN_RUNTIME, "trusted Electron IPC anchor");
}

function applyPreloadPatch(extractedDir) {
  const target = path.join(extractedDir, ".vite", "build", "preload.js");
  if (!fs.existsSync(target)) {
    console.warn(`WARN: Could not find ${target} - skipping account-switcher preload bridge`);
    return { matched: 0, changed: 0 };
  }
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(PRELOAD_MARKER)) return { matched: 1, changed: 0 };
  const needle = "usesOwlAppShell:()=>E};";
  const replacement = `usesOwlAppShell:()=>E,getLinuxAccountProfiles:()=>e.ipcRenderer.invoke("codex_linux_account_switcher",{action:"list"}),refreshLinuxAccountProfiles:()=>e.ipcRenderer.invoke("codex_linux_account_switcher",{action:"refresh"}),createLinuxAccountProfile:t=>e.ipcRenderer.invoke("codex_linux_account_switcher",{action:"create",...t}),setLinuxAccountSwitcherSettings:t=>e.ipcRenderer.invoke("codex_linux_account_switcher",{action:"set-settings",...t}),switchLinuxAccountProfile:t=>e.ipcRenderer.invoke("codex_linux_account_switcher",{action:"switch",...t})};/*${PRELOAD_MARKER}*/`;
  const patched = replaceOnce(source, needle, replacement, "Electron preload bridge anchor");
  if (patched !== source) fs.writeFileSync(target, patched, "utf8");
  return { matched: 1, changed: patched === source ? 0 : 1 };
}

function applyProfileMenuPatch(source) {
  if (source.includes(MENU_MARKER)) return source;
  const needle = "children:[v,y,o,b,h,S,i,w,T]})";
  const replacement = `children:[v,y,o,b,h,S,i,w,T,(0,l7.jsx)(fI,{LeftIcon:KGl,onClick:()=>window.codexLinuxOpenAccountSwitcher?.(),children:(0,l7.jsx)(Z,{id:\`codex.profileDropdown.switchAccount\`,defaultMessage:\`Switch account\`,description:\`Menu item to switch between local Codex account profiles\`})})]})/*${MENU_MARKER}*/`;
  const patched = replaceOnce(source, needle, replacement, "profile menu logout anchor");
  // The extracted webview bundle currently ends with a source-map comment. A
  // leading newline is required so the runtime is not swallowed by that
  // comment and its `return` statements remain inside the IIFE.
  return patched === source ? source : patched + "\n" + WEBVIEW_RUNTIME;
}

function patchPreload(extractedDir) {
  const result = applyPreloadPatch(extractedDir);
  return { changed: result.changed === 1, ...result };
}

module.exports = {
  MAIN_MARKER,
  PRELOAD_MARKER,
  MENU_MARKER,
  RUNTIME_MARKER,
  applyMainBundlePatch,
  applyPreloadPatch,
  applyProfileMenuPatch,
  descriptors: [
    mainBundlePatch({ id: "main-profile-ipc", order: 29_100, ciPolicy: "opt-in", apply: applyMainBundlePatch }),
    extractedAppPatch({
      id: "preload-profile-bridge",
      phase: "extracted-app:pre-webview",
      order: 29_110,
      ciPolicy: "opt-in",
      apply: patchPreload,
      status: (result, warnings) => result?.matched !== 1
        ? { status: "skipped-optional", reason: warnings[0] || "preload bridge not found" }
        : result.changed ? "applied" : "already-applied",
    }),
    webviewAssetPatch({
      id: "account-switcher-ui",
      order: 29_120,
      ciPolicy: "opt-in",
      pattern: /^app-initial-[^.]+\.js$/,
      assetMatch: (source) => source.includes("codex.profileDropdown.logOut") && source.includes("children:[v,y,o,b,h,S,i,w,T]"),
      missingDescription: "current profile-menu webview bundle",
      skipDescription: "account-switcher menu item",
      apply: applyProfileMenuPatch,
    }),
  ],
};
