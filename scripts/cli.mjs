#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  VoidClient,
  VoidError,
  generateTypeDefinitions,
  parseSchemaFile,
  renderSchemaFile,
} from "../dist/index.mjs";

const DEFAULT_URL = process.env.VOIDDB_URL || "http://localhost:7700";
const DEFAULT_SCHEMA_PATH = "void.schema.prisma";
const DEFAULT_TYPES_OUTPUT = "voiddb.generated.d.ts";
const DEFAULT_MIGRATIONS_DIR = path.join("void", "migrations");
const MIGRATION_DB = "__void";
const MIGRATION_COLLECTION = "orm_migrations";

function invokedArgs() {
  const invoked = path.basename(process.argv[1] || "");
  const args = process.argv.slice(2);
  if ((invoked === "voiddb-generate" || invoked === "voiddb-types") && (args.length === 0 || args[0].startsWith("-"))) {
    return ["generate", ...args];
  }
  if (invoked === "voiddb-schema" && (args.length === 0 || args[0].startsWith("-"))) {
    return ["schema", ...args];
  }
  if (invoked === "voiddb-migrate" && (args.length === 0 || args[0].startsWith("-"))) {
    return ["migrate", ...args];
  }
  return args;
}

const argv = invokedArgs();

function arg(name, fallback = "") {
  const exact = `--${name}`;
  const prefixed = `${exact}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === exact) {
      return argv[index + 1] ?? fallback;
    }
    if (token.startsWith(prefixed)) {
      return token.slice(prefixed.length);
    }
  }
  return fallback;
}

function flag(name) {
  return argv.includes(`--${name}`);
}

function positional() {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      if (!token.includes("=") && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    out.push(token);
  }
  return out;
}

function requireArg(name) {
  const value = arg(name);
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function usage() {
  process.stdout.write(`VoidDB ORM CLI

Usage:
  voiddb-orm generate [--schema path] [--output file] [--module name]
  voiddb-orm schema pull [--out file]
  voiddb-orm schema plan --schema file [--force-drop] [--json]
  voiddb-orm schema push --schema file [--dry-run] [--force-drop] [--json]
  voiddb-orm migrate dev --schema file --name name [--dir dir] [--create-only] [--force-drop]
  voiddb-orm migrate deploy [--dir dir]
  voiddb-orm migrate status [--dir dir] [--json]

Auth:
  --url        VoidDB URL (default: ${DEFAULT_URL})
  --token      Existing access token
  --username   Login username
  --password   Login password

Examples:
  npx voiddb-orm schema pull --url http://localhost:7700 --username admin --password admin
  npx voiddb-orm generate --schema ./void.schema.prisma --output ./src/generated/voiddb.d.ts
  bunx voiddb-orm migrate dev --schema ./void.schema.prisma --name add_users
`);
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target) {
  return stripBom(await fs.readFile(target, "utf8"));
}

async function writeText(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "migration";
}

function migrationId(name) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}_${slugify(name)}`;
}

function printPlan(plan, asJson = false) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (!plan.operations?.length) {
    process.stdout.write("No schema changes.\n");
    return;
  }
  plan.operations.forEach((op, index) => {
    process.stdout.write(`${index + 1}. ${op.summary}\n`);
  });
}

async function getClient(required = true) {
  const url = arg("url", DEFAULT_URL);
  const token = arg("token", process.env.VOIDDB_TOKEN || "");
  const username = arg("username", process.env.VOIDDB_USERNAME || "");
  const password = arg("password", process.env.VOIDDB_PASSWORD || "");
  const client = new VoidClient({ url, token: token || undefined });

  if (!token && username && password) {
    await client.login(username, password);
  }

  if (required && !client.getToken()) {
    throw new Error("authentication required: pass --token or --username/--password");
  }

  return client;
}

async function loadProjectFromSchemaFile(schemaPath) {
  const source = await readText(schemaPath);
  return parseSchemaFile(source);
}

function checksumForMigration(payload) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(payload));
  return hash.digest("hex");
}

async function ensureMigrationStore(client) {
  const dbs = await client.listDatabases();
  if (!dbs.includes(MIGRATION_DB)) {
    await client.createDatabase(MIGRATION_DB);
  }
  const db = client.db(MIGRATION_DB);
  const collections = await db.listCollections();
  if (!collections.includes(MIGRATION_COLLECTION)) {
    await db.createCollection(MIGRATION_COLLECTION);
  }
  return db.collection(MIGRATION_COLLECTION);
}

async function loadAppliedMigrations(client) {
  const col = await ensureMigrationStore(client);
  const rows = await col.find();
  const map = new Map();
  for (const row of rows) {
    map.set(row._id, row);
  }
  return { col, map };
}

async function markMigrationApplied(client, migration) {
  const { col, map } = await loadAppliedMigrations(client);
  const payload = {
    _id: migration.id,
    name: migration.name,
    checksum: migration.checksum,
    applied_at: new Date().toISOString(),
    source: "voiddb-orm",
  };

  if (map.has(migration.id)) {
    await col.patch(migration.id, {
      name: payload.name,
      checksum: payload.checksum,
      applied_at: payload.applied_at,
      source: payload.source,
    });
    return;
  }

  await col.insert(payload);
}

async function loadLocalMigrations(dir) {
  if (!(await fileExists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(dir, entry.name, "migration.json");
    if (!(await fileExists(file))) {
      continue;
    }
    const parsed = JSON.parse(await readText(file));
    parsed.id ||= entry.name;
    parsed.directory = path.join(dir, entry.name);
    migrations.push(parsed);
  }
  return migrations;
}

async function commandGenerate() {
  const schemaPath = arg("schema");
  const output = path.resolve(process.cwd(), arg("output", DEFAULT_TYPES_OUTPUT));
  const moduleName = arg("module", path.basename(process.cwd()));
  const project = schemaPath
    ? await loadProjectFromSchemaFile(path.resolve(process.cwd(), schemaPath))
    : await (await getClient()).schema.pull();

  const rendered = generateTypeDefinitions(project, { moduleName });
  await writeText(output, rendered);
  process.stdout.write(`Generated ${project.models.length} model(s) -> ${output}\n`);
}

async function commandSchemaPull() {
  const out = path.resolve(process.cwd(), arg("out", DEFAULT_SCHEMA_PATH));
  const project = await (await getClient()).schema.pull();
  await writeText(out, renderSchemaFile(project));
  process.stdout.write(`Pulled schema -> ${out}\n`);
}

async function commandSchemaPlan() {
  const schemaPath = path.resolve(process.cwd(), requireArg("schema"));
  const client = await getClient();
  const project = await loadProjectFromSchemaFile(schemaPath);
  const plan = await client.schema.plan(project, { forceDrop: flag("force-drop") });
  printPlan(plan, flag("json"));
}

async function commandSchemaPush() {
  const schemaPath = path.resolve(process.cwd(), requireArg("schema"));
  const client = await getClient();
  const project = await loadProjectFromSchemaFile(schemaPath);
  const options = {
    dryRun: flag("dry-run"),
    forceDrop: flag("force-drop"),
  };
  const plan = await client.schema.push(project, options);
  printPlan(plan, flag("json"));
}

async function commandMigrateDev() {
  const schemaPath = path.resolve(process.cwd(), requireArg("schema"));
  const name = arg("name", "migration");
  const dir = path.resolve(process.cwd(), arg("dir", DEFAULT_MIGRATIONS_DIR));
  const forceDrop = flag("force-drop");
  const createOnly = flag("create-only");
  const client = await getClient();
  const project = await loadProjectFromSchemaFile(schemaPath);
  const plan = await client.schema.plan(project, { forceDrop });

  if (!plan.operations.length) {
    process.stdout.write("No schema changes.\n");
    return;
  }

  const id = migrationId(name);
  const migrationDir = path.join(dir, id);
  await fs.mkdir(migrationDir, { recursive: true });

  const migration = {
    id,
    name,
    createdAt: new Date().toISOString(),
    forceDrop,
    project,
    plan,
  };
  migration.checksum = checksumForMigration({
    id: migration.id,
    name: migration.name,
    forceDrop: migration.forceDrop,
    project: migration.project,
    plan: migration.plan,
  });

  await writeText(path.join(migrationDir, "schema.prisma"), renderSchemaFile(project));
  await writeText(path.join(migrationDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await writeText(path.join(migrationDir, "migration.json"), `${JSON.stringify(migration, null, 2)}\n`);

  process.stdout.write(`Created migration ${id}\n`);
  printPlan(plan, false);

  if (createOnly) {
    return;
  }

  await client.schema.push(project, { forceDrop });
  await markMigrationApplied(client, migration);
  process.stdout.write(`Applied migration ${id}\n`);
}

async function commandMigrateDeploy() {
  const dir = path.resolve(process.cwd(), arg("dir", DEFAULT_MIGRATIONS_DIR));
  const client = await getClient();
  const migrations = await loadLocalMigrations(dir);
  const { map } = await loadAppliedMigrations(client);

  if (!migrations.length) {
    process.stdout.write(`No migrations found in ${dir}\n`);
    return;
  }

  let appliedCount = 0;
  for (const migration of migrations) {
    const checksum = checksumForMigration({
      id: migration.id,
      name: migration.name,
      forceDrop: Boolean(migration.forceDrop),
      project: migration.project,
      plan: migration.plan,
    });
    if (migration.checksum && migration.checksum !== checksum) {
      throw new Error(`migration checksum mismatch for ${migration.id}`);
    }
    migration.checksum = checksum;

    if (map.has(migration.id)) {
      process.stdout.write(`Skipping already applied migration ${migration.id}\n`);
      continue;
    }

    await client.schema.push(migration.project, { forceDrop: Boolean(migration.forceDrop) });
    await markMigrationApplied(client, migration);
    appliedCount += 1;
    process.stdout.write(`Applied migration ${migration.id}\n`);
  }

  if (appliedCount === 0) {
    process.stdout.write("All migrations are already applied.\n");
  }
}

async function commandMigrateStatus() {
  const dir = path.resolve(process.cwd(), arg("dir", DEFAULT_MIGRATIONS_DIR));
  const client = await getClient();
  const migrations = await loadLocalMigrations(dir);
  const { map } = await loadAppliedMigrations(client);

  const rows = migrations.map((migration) => ({
    id: migration.id,
    name: migration.name,
    status: map.has(migration.id) ? "APPLIED" : "PENDING",
    applied_at: map.get(migration.id)?.applied_at || null,
  }));

  if (flag("json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (!rows.length) {
    process.stdout.write(`No migrations found in ${dir}\n`);
    return;
  }

  for (const row of rows) {
    process.stdout.write(`${row.status.padEnd(8)} ${row.id} ${row.name || ""}\n`);
  }
}

async function main() {
  const args = positional();
  const [group = "help", action = ""] = args;

  if (group === "help" || flag("help")) {
    usage();
    return;
  }

  if (group === "generate") {
    await commandGenerate();
    return;
  }

  if (group === "schema") {
    if (action === "pull") return commandSchemaPull();
    if (action === "plan") return commandSchemaPlan();
    if (action === "push") return commandSchemaPush();
    throw new Error(`unknown schema command: ${action || "<missing>"}`);
  }

  if (group === "migrate") {
    if (action === "dev") return commandMigrateDev();
    if (action === "deploy") return commandMigrateDeploy();
    if (action === "status") return commandMigrateStatus();
    throw new Error(`unknown migrate command: ${action || "<missing>"}`);
  }

  throw new Error(`unknown command: ${group}`);
}

main().catch((error) => {
  if (error instanceof VoidError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error?.stack || error}\n`);
  }
  process.exit(1);
});
