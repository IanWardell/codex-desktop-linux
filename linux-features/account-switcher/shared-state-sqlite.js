#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function usage() {
  console.error("usage: shared-state-sqlite.js rewrite-rollout-paths <codex-home> <shared-root> | sync-local-history <source-home> <target-home> <shared-root> | merge-catalog <incoming-db> <shared-db>");
  process.exit(2);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isSqliteDatabase(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    return fs.readSync(fd, header, 0, 16, 0) === 16 && header.equals(Buffer.from("SQLite format 3\0"));
  } finally {
    fs.closeSync(fd);
  }
}

function mergeCatalog(incomingPath, sharedPath) {
  // Some focused shell fixtures intentionally use opaque catalog bytes. Real
  // Codex catalogs are SQLite; leave opaque files on the preservation path.
  if (!isSqliteDatabase(incomingPath) || !isSqliteDatabase(sharedPath)) return;
  const db = new DatabaseSync(sharedPath);
  try {
    db.exec("pragma foreign_keys=off");
    db.prepare("attach database ? as incoming").run(incomingPath);
    db.exec("begin immediate");
    const tables = db.prepare("select name, sql from incoming.sqlite_master where type='table' and name not like 'sqlite_%' and sql is not null order by name").all();
    for (const table of tables) {
      const name = String(table.name);
      const quoted = quoteIdentifier(name);
      const targetExists = db.prepare("select 1 as found from main.sqlite_master where type='table' and name=?").get(name);
      if (!targetExists) db.exec(String(table.sql));
      const incomingColumns = db.prepare(`pragma incoming.table_info(${quoted})`).all().map((column) => String(column.name));
      const targetColumns = new Set(db.prepare(`pragma main.table_info(${quoted})`).all().map((column) => String(column.name)));
      const columns = incomingColumns.filter((column) => targetColumns.has(column));
      if (columns.length === 0) continue;
      const list = columns.map(quoteIdentifier).join(",");
      db.exec(`insert or ignore into main.${quoted} (${list}) select ${list} from incoming.${quoted}`);
    }
    db.exec("commit");
    db.exec("detach database incoming");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    try { db.exec("detach database incoming"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function tableInfo(db, schema, table) {
  return db.prepare(`pragma ${schema}.table_info(${quoteIdentifier(table)})`).all();
}

function tableExists(db, schema, table) {
  return db.prepare(`select 1 as found from ${schema}.sqlite_master where type = 'table' and name = ?`).get(table);
}

function upsertRows(db, table, rows, conflictPolicy = "update") {
  if (rows.length === 0) return;
  const incomingColumns = tableInfo(db, "incoming", table).map((column) => String(column.name));
  const targetInfo = tableInfo(db, "main", table);
  const targetColumns = new Set(targetInfo.map((column) => String(column.name)));
  const columns = incomingColumns.filter((column) => targetColumns.has(column));
  if (columns.length === 0) return;

  const primaryKey = targetInfo
    .filter((column) => Number(column.pk) > 0 && columns.includes(String(column.name)))
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => String(column.name));
  const quotedColumns = columns.map(quoteIdentifier).join(",");
  const placeholders = columns.map(() => "?").join(",");
  let insert = `insert into main.${quoteIdentifier(table)} (${quotedColumns}) values (${placeholders})`;
  if (primaryKey.length > 0) {
    const updates = columns.filter((column) => !primaryKey.includes(column));
    insert += ` on conflict (${primaryKey.map(quoteIdentifier).join(",")}) `;
    insert += conflictPolicy === "ignore" || updates.length === 0
      ? "do nothing"
      : `do update set ${updates.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(",")}`;
  } else {
    insert = insert.replace(/^insert into /, "insert or ignore into ");
  }

  const statement = db.prepare(insert);
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

function localSessionRelative(rolloutPath, sourceHome, sharedRoot) {
  if (typeof rolloutPath !== "string" || rolloutPath.length === 0) return null;
  const candidate = path.resolve(rolloutPath);
  for (const sessionRoot of [path.join(sourceHome, "sessions"), path.join(sharedRoot, "sessions")]) {
    const relative = path.relative(path.resolve(sessionRoot), candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (relative.split(path.sep).includes("..")) continue;
    try {
      if (fs.lstatSync(path.join(sharedRoot, "sessions", relative)).isFile()) return relative;
    } catch {}
  }
  return null;
}

function rewriteManagedRolloutPaths(db, codexHome, sharedRoot) {
  const sharedContextsRoot = path.dirname(path.resolve(sharedRoot));
  const managedContextPrefix = `${sharedContextsRoot}/`;
  const targetPrefix = `${path.resolve(codexHome)}/sessions/`;
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
}

function syncLocalHistory(sourceHome, targetHome, sharedRoot) {
  const sameHome = path.resolve(sourceHome) === path.resolve(targetHome);
  const targetEntries = fs.readdirSync(targetHome, { withFileTypes: true });
  for (const entry of targetEntries) {
    if (!entry.isFile() || !/^state_[0-9]+\.sqlite$/.test(entry.name)) continue;
    const targetPath = path.join(targetHome, entry.name);
    const sourcePath = path.join(sourceHome, entry.name);
    const db = new DatabaseSync(targetPath);
    let attached = false;
    try {
      if (!sameHome && fs.existsSync(sourcePath) && !fs.lstatSync(sourcePath).isSymbolicLink()) {
        db.prepare("attach database ? as incoming").run(sourcePath);
        attached = true;
      }
      db.exec("pragma foreign_keys=off");
      db.exec("begin immediate");
      if (attached && tableExists(db, "incoming", "threads") && tableExists(db, "main", "threads")) {
        const sourceProjects = tableExists(db, "incoming", "projects")
          ? db.prepare("select * from incoming.projects").all()
          : [];
        upsertRows(db, "projects", sourceProjects, "ignore");

        const projectIds = new Set(sourceProjects.map((project) => project.id).filter((id) => id != null));
        if (projectIds.size > 0 && tableExists(db, "incoming", "project_roots") && tableExists(db, "main", "project_roots")) {
          const sourceRoots = db.prepare("select * from incoming.project_roots").all()
            .filter((projectRoot) => projectIds.has(projectRoot.project_id));
          upsertRows(db, "project_roots", sourceRoots, "ignore");
        }

        const sourceThreads = db.prepare("select * from incoming.threads").all();
        const localThreads = [];
        for (const thread of sourceThreads) {
          const relative = localSessionRelative(thread.rollout_path, sourceHome, sharedRoot);
          if (relative == null) continue;
          localThreads.push({ ...thread, rollout_path: path.join(targetHome, "sessions", relative) });
        }
        upsertRows(db, "threads", localThreads, "ignore");
      }
      if (tableExists(db, "main", "threads")) rewriteManagedRolloutPaths(db, targetHome, sharedRoot);
      if (tableExists(db, "main", "backfill_state")) {
        db.prepare("delete from main.backfill_state where id = 1").run();
      }
      db.exec("commit");
      const checkpoint = db.prepare("pragma wal_checkpoint(truncate)").get();
      if (Number(checkpoint?.busy) > 0) throw new Error(`could not checkpoint ${targetPath}`);
    } catch (error) {
      try { db.exec("rollback"); } catch {}
      throw error;
    } finally {
      if (attached) {
        try { db.exec("detach database incoming"); } catch {}
      }
      db.close();
    }
  }
}

const [, , action, codexHome, sharedRoot] = process.argv;
if (!action || !codexHome || !sharedRoot) usage();

if (action === "merge-catalog") {
  mergeCatalog(codexHome, sharedRoot);
  process.exit(0);
}

if (action === "sync-local-history") {
  const [, , , sourceHome, targetHome, localSharedRoot] = process.argv;
  if (!sourceHome || !targetHome || !localSharedRoot) usage();
  syncLocalHistory(sourceHome, targetHome, localSharedRoot);
  process.exit(0);
}

if (action !== "rewrite-rollout-paths") usage();

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
    rewriteManagedRolloutPaths(db, codexHome, sharedRoot);
    const backfillTable = db.prepare("select name from sqlite_master where type = 'table' and name = 'backfill_state'").get();
    if (backfillTable) db.prepare("delete from backfill_state where id = 1").run();
    db.exec("commit");
  } catch (error) {
    try { db.exec("rollback"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}
