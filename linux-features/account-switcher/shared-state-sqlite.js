#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function usage() {
  console.error("usage: shared-state-sqlite.js rewrite-rollout-paths <codex-home> <shared-root>");
  process.exit(2);
}

const [, , action, codexHome, sharedRoot] = process.argv;
if (action !== "rewrite-rollout-paths" || !codexHome || !sharedRoot) usage();

const sharedContextsRoot = path.dirname(path.resolve(sharedRoot));
const managedContextPrefix = `${sharedContextsRoot}/`;
const targetPrefix = `${path.resolve(codexHome)}/sessions/`;
const entries = fs.readdirSync(codexHome, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isFile() || !/^state_[0-9]+\.sqlite$/.test(entry.name)) continue;
  const databasePath = path.join(codexHome, entry.name);
  const db = new DatabaseSync(databasePath);
  try {
    const table = db.prepare("select name from sqlite_master where type = 'table' and name = 'threads'").get();
    if (!table) continue;
    db.exec("begin immediate");
    const rows = db.prepare("select id, rollout_path from threads where rollout_path like ?").all(`${managedContextPrefix}%/sessions/%`);
    const update = db.prepare("update threads set rollout_path = ? where id = ?");
    for (const row of rows) {
      const rolloutPath = String(row.rollout_path);
      if (!rolloutPath.startsWith(managedContextPrefix)) continue;
      const relative = rolloutPath.slice(managedContextPrefix.length);
      const sessionsMarker = "/sessions/";
      const markerIndex = relative.indexOf(sessionsMarker);
      if (markerIndex <= 0) continue;
      const contextId = relative.slice(0, markerIndex);
      const sessionRelative = relative.slice(markerIndex + sessionsMarker.length);
      if (contextId.includes("/") || !sessionRelative || sessionRelative.split("/").includes("..")) continue;
      update.run(`${targetPrefix}${sessionRelative}`, row.id);
    }
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}
