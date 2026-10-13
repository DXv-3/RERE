// Upgrade smoke test for a packaged Workbench Preview build.
//
// Starts the app's bundled backend against a snapshot of a real database and
// fails unless every migration in this checkout applies and the result passes
// SQLite's integrity check. The source database is only ever read.
//
//   node scripts/preview-upgrade-smoke.mjs --app "<path>/Workbench Preview.app" [--source-db <path>]

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const STARTUP_TIMEOUT_MS = 90_000;
const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const fail = (message) => {
  console.error(`upgrade-smoke: FAILED: ${message}`);
  process.exit(1);
};

const appPath = argument("app") ?? fail("--app <path to .app> is required");
const sourceDb =
  argument("source-db") ??
  NodePath.join(NodeOS.homedir(), ".workbench-preview/userdata/statev2.sqlite");
const macosDir = NodePath.join(appPath, "Contents/MacOS");
const executableName = NodeFS.readdirSync(macosDir)[0] ?? fail(`no executable in ${macosDir}`);
const executable = NodePath.join(macosDir, executableName);
// Electron resolves paths inside app.asar when run as Node.
const entry = NodePath.join(appPath, "Contents/Resources/app.asar/apps/server/dist/bin.mjs");

const migrationSource = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "../apps/server/src/persistence/Migrations.ts"),
  "utf8",
);
const expected = [...migrationSource.matchAll(/^\s*\[(\d+), "/gm)].map((match) => Number(match[1]));
if (expected.length === 0) fail("could not read the migration list from this checkout");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workbench-upgrade-smoke-"));
const stateDir = NodePath.join(home, "userdata");
const copy = NodePath.join(stateDir, "statev2.sqlite");
NodeFS.mkdirSync(stateDir, { recursive: true });

// VACUUM INTO yields one consistent file even while the installed app has the source open.
const source = new NodeSqlite.DatabaseSync(sourceDb, { readOnly: true });
source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
source.close();

const counts = (database) => {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%projection%'")
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      database.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n,
    ]),
  );
};
const applied = (database) =>
  database
    .prepare("SELECT migration_id FROM effect_sql_migrations")
    .all()
    .map((row) => row.migration_id);

const before = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
const countsBefore = counts(before);
const appliedBefore = applied(before);
before.close();

const port = await new Promise((resolve, reject) => {
  const server = NodeNet.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const log = NodeFS.openSync(NodePath.join(home, "backend.log"), "w");
const backend = NodeChildProcess.spawn(
  executable,
  [entry, "--base-dir", home, "--port", String(port), "--host", "127.0.0.1", "--no-browser"],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", log, log] },
);
let exited;
backend.once("exit", (code) => {
  exited = code;
});

const missing = () => {
  const database = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
  try {
    const done = new Set(applied(database));
    return expected.filter((id) => !done.has(id));
  } finally {
    database.close();
  }
};
const deadline = Date.now() + STARTUP_TIMEOUT_MS;
let pending = missing();
while (pending.length > 0 && exited === undefined && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  pending = missing();
}
// Only the process this script spawned is ever signalled.
if (exited === undefined) backend.kill("SIGTERM");
await new Promise((resolve) => (exited === undefined ? backend.once("exit", resolve) : resolve(0)));
NodeFS.closeSync(log);

const after = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
const integrity = after.prepare("PRAGMA integrity_check").get().integrity_check;
const countsAfter = counts(after);
after.close();

const lost = Object.entries(countsBefore).filter(([name, n]) => (countsAfter[name] ?? 0) < n);
const report = {
  app: appPath,
  sourceDb,
  scratchHome: home,
  migrationsBefore: Math.max(...appliedBefore),
  migrationsExpected: Math.max(...expected),
  migrationsMissing: pending,
  integrity,
  tablesThatLostRows: lost.map(([name, n]) => `${name}: ${n} -> ${countsAfter[name] ?? 0}`),
  threads: countsAfter.orchestration_v2_projection_threads ?? null,
  projects: countsAfter.projection_projects ?? null,
};
console.log(JSON.stringify(report, null, 2));
if (pending.length > 0)
  fail(`migrations not applied: ${pending.join(", ")} (backend log: ${home}/backend.log)`);
if (integrity !== "ok") fail(`integrity check: ${integrity}`);
if (lost.length > 0) fail(`rows lost in ${lost.map(([name]) => name).join(", ")}`);
console.log("upgrade-smoke: passed");
