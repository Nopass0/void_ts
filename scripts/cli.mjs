#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  VoidClient,
  VoidError,
  generateTypeDefinitions,
  parseSchemaFile,
  renderSchemaFile,
} from "../dist/index.mjs";

const DEFAULT_CONFIG_PATH = ".voiddb/config.json";
const DEFAULT_SCHEMA_PATH = ".voiddb/schema/app.schema";
const DEFAULT_TYPES_OUTPUT = ".voiddb/generated/voiddb.generated.d.ts";
const DEFAULT_MIGRATIONS_DIR = ".voiddb/migrations";
const DEFAULT_URL = "http://localhost:7700";
const ENV_FILE_CANDIDATES = [".env", ".env.local", ".voiddb/.env", ".voiddb/.env.local"];
const CONFIG_CANDIDATES = [DEFAULT_CONFIG_PATH, "voiddb.config.json"];
const MIGRATION_DB = "__void";
const MIGRATION_COLLECTION = "orm_migrations";

function readRawArg(name, fallback = "") {
  const exact = `--${name}`;
  const prefixed = `${exact}=`;
  const raw = process.argv.slice(2);
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === exact) {
      return raw[index + 1] ?? fallback;
    }
    if (token.startsWith(prefixed)) {
      return token.slice(prefixed.length);
    }
  }
  return fallback;
}

function parseEnv(text) {
  const vars = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    let [, key, value] = match;
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars.set(key, value);
  }
  return vars;
}

function loadEnvFiles(cwd) {
  const explicit = readRawArg("env-file");
  const candidates = explicit ? [explicit] : ENV_FILE_CANDIDATES;
  for (const candidate of candidates) {
    const target = path.resolve(cwd, candidate);
    if (!fs.existsSync(target)) {
      continue;
    }
    const vars = parseEnv(fs.readFileSync(target, "utf8"));
    for (const [key, value] of vars) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

loadEnvFiles(process.cwd());

function invokedArgs() {
  const invoked = path.basename(process.argv[1] || "");
  const args = process.argv.slice(2);
  if (
    ["voiddb-generate", "voiddb-types", "vdb-gen", "vdb-types"].includes(invoked) &&
    (args.length === 0 || args[0].startsWith("-"))
  ) {
    return ["generate", ...args];
  }
  if (["voiddb-schema", "vdb-schema"].includes(invoked) && (args.length === 0 || args[0].startsWith("-"))) {
    return ["schema", ...args];
  }
  if (["voiddb-migrate", "vdb-migrate"].includes(invoked) && (args.length === 0 || args[0].startsWith("-"))) {
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

function normalizeCommand(args) {
  if (args.length === 0) {
    return ["help"];
  }
  const [group, ...rest] = args;
  const aliases = new Map([
    ["pull", ["schema", "pull"]],
    ["plan", ["schema", "plan"]],
    ["push", ["schema", "push"]],
    ["gen", ["generate"]],
    ["types", ["generate"]],
    ["init", ["init"]],
    ["dev", ["migrate", "dev"]],
    ["deploy", ["migrate", "deploy"]],
    ["status", ["migrate", "status"]],
  ]);
  return aliases.has(group) ? [...aliases.get(group), ...rest] : args;
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

async function fileExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target) {
  return stripBom(await fsp.readFile(target, "utf8"));
}

async function writeText(target, contents) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents, "utf8");
}

function readJsonIfExists(target) {
  if (!fs.existsSync(target)) {
    return {};
  }
  return JSON.parse(stripBom(fs.readFileSync(target, "utf8")));
}

function loadConfig(cwd) {
  const explicit = arg("config", readRawArg("config"));
  if (explicit) {
    const target = path.resolve(cwd, explicit);
    return { path: target, data: readJsonIfExists(target) };
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const target = path.resolve(cwd, candidate);
    if (fs.existsSync(target)) {
      return { path: target, data: readJsonIfExists(target) };
    }
  }

  return {
    path: path.resolve(cwd, DEFAULT_CONFIG_PATH),
    data: {},
  };
}

function normalizeConfig(data) {
  const paths = data.paths ?? {};
  const env = data.env ?? {};
  return {
    url: data.url ?? "",
    token: data.token ?? "",
    username: data.username ?? "",
    password: data.password ?? "",
    moduleName: data.moduleName ?? "",
    schema: paths.schema ?? data.schema ?? "",
    types: paths.types ?? data.types ?? data.generated ?? "",
    migrations: paths.migrations ?? data.migrations ?? "",
    env: {
      url: env.url ?? data.urlEnv ?? "VOIDDB_URL",
      token: env.token ?? data.tokenEnv ?? "VOIDDB_TOKEN",
      username: env.username ?? data.usernameEnv ?? "VOIDDB_USERNAME",
      password: env.password ?? data.passwordEnv ?? "VOIDDB_PASSWORD",
    },
  };
}

const loadedConfig = loadConfig(process.cwd());
const cliConfig = normalizeConfig(loadedConfig.data);

function envSetting(name) {
  return process.env[name] || "";
}

function resolveSettings() {
  const cwd = process.cwd();
  const schema = arg("schema", envSetting("VOIDDB_SCHEMA") || cliConfig.schema || DEFAULT_SCHEMA_PATH);
  const types =
    arg("types", arg("output", envSetting("VOIDDB_TYPES") || cliConfig.types || DEFAULT_TYPES_OUTPUT));
  const migrations = arg("dir", envSetting("VOIDDB_MIGRATIONS") || cliConfig.migrations || DEFAULT_MIGRATIONS_DIR);
  const moduleName = arg("module", envSetting("VOIDDB_MODULE") || cliConfig.moduleName || path.basename(cwd));
  const url = arg("url", envSetting(cliConfig.env.url) || cliConfig.url || DEFAULT_URL);
  const token = arg("token", envSetting(cliConfig.env.token) || cliConfig.token || "");
  const username = arg("username", envSetting(cliConfig.env.username) || cliConfig.username || "");
  const password = arg("password", envSetting(cliConfig.env.password) || cliConfig.password || "");
  return {
    cwd,
    configPath: loadedConfig.path,
    schemaPath: path.resolve(cwd, schema),
    typesPath: path.resolve(cwd, types),
    migrationsDir: path.resolve(cwd, migrations),
    moduleName,
    url,
    token,
    username,
    password,
  };
}

function relativeUnix(fromDir, toFile) {
  const rel = path.relative(fromDir, toFile).replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const settings = resolveSettings();

function usage() {
  process.stdout.write(`VoidDB ORM CLI

Short commands:
  vdb init
  vdb pull
  vdb plan
  vdb push
  vdb gen
  vdb dev --name add_users
  vdb deploy
  vdb status

Long commands:
  voiddb-orm init
  voiddb-orm schema pull [--out file]
  voiddb-orm schema plan [--schema file] [--force-drop] [--json]
  voiddb-orm schema push [--schema file] [--dry-run] [--force-drop] [--json]
  voiddb-orm generate [--schema file] [--output file] [--module name] [--from-db]
  voiddb-orm migrate dev [--schema file] --name name [--dir dir] [--create-only] [--force-drop]
  voiddb-orm migrate deploy [--dir dir]
  voiddb-orm migrate status [--dir dir] [--json]

Defaults:
  config     ${path.relative(settings.cwd, settings.configPath) || "."}
  schema     ${path.relative(settings.cwd, settings.schemaPath) || "."}
  types      ${path.relative(settings.cwd, settings.typesPath) || "."}
  migrations ${path.relative(settings.cwd, settings.migrationsDir) || "."}

Env:
  ${cliConfig.env.url}       VoidDB URL (default ${DEFAULT_URL})
  ${cliConfig.env.token}     Existing access token
  ${cliConfig.env.username}  Login username
  ${cliConfig.env.password}  Login password

Examples:
  npx --package=@voiddb/orm vdb init
  npx --package=@voiddb/orm vdb pull
  npx --package=@voiddb/orm vdb push
  bunx --package @voiddb/orm vdb dev --name add_users
`);
}

function slugify(value) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "migration"
  );
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
  const client = new VoidClient({
    url: settings.url,
    token: settings.token || undefined,
  });

  if (!settings.token && settings.username && settings.password) {
    await client.login(settings.username, settings.password);
  }

  if (required && !client.getToken()) {
    throw new Error(
      `authentication required: set ${cliConfig.env.token} or ${cliConfig.env.username}/${cliConfig.env.password}, or pass --token / --username --password`
    );
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
  const entries = await fsp.readdir(dir, { withFileTypes: true });
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

function generatedIndexContents(output) {
  const base = path.basename(output);
  if (base === "index.d.ts") {
    return null;
  }
  const stem = base.endsWith(".d.ts")
    ? base.slice(0, -5)
    : base.endsWith(".d.mts")
      ? base.slice(0, -6)
      : base.replace(/\.[^.]+$/, "");
  return `export * from "./${stem}";\n`;
}

async function writeGeneratedArtifacts(output, contents) {
  await writeText(output, contents);
  const index = generatedIndexContents(output);
  if (!index) {
    return;
  }
  const dir = path.dirname(output);
  await writeText(path.join(dir, "index.d.ts"), index);
  await writeText(path.join(dir, "index.js"), "module.exports = {};\n");
}

async function autoGenerate(project) {
  if (flag("no-generate")) {
    return;
  }
  const rendered = generateTypeDefinitions(project, { moduleName: settings.moduleName });
  await writeGeneratedArtifacts(settings.typesPath, rendered);
  process.stdout.write(`Generated types -> ${settings.typesPath}\n`);
}

async function resolveProjectForGenerate() {
  if (flag("from-db")) {
    return (await getClient()).schema.pull();
  }
  if (await fileExists(settings.schemaPath)) {
    return loadProjectFromSchemaFile(settings.schemaPath);
  }
  return (await getClient()).schema.pull();
}

function initProjectTemplate() {
  const generatedDir = path.dirname(settings.typesPath);
  const schemaDir = path.dirname(settings.schemaPath);
  return {
    datasource: {
      name: "db",
      provider: "voiddb",
      url: `env("${cliConfig.env.url}")`,
    },
    generator: {
      name: "client",
      provider: "voiddb-client-js",
      output: relativeUnix(schemaDir, generatedDir),
    },
    models: [
      {
        name: "User",
        schema: {
          database: "app",
          collection: "users",
          model: "User",
          fields: [
            {
              name: "id",
              type: "string",
              required: true,
              is_id: true,
              prisma_type: "String",
            },
            {
              name: "email",
              type: "string",
              required: true,
              unique: true,
              prisma_type: "String",
            },
            {
              name: "name",
              type: "string",
              required: true,
              prisma_type: "String",
            },
            {
              name: "createdAt",
              type: "datetime",
              required: true,
              prisma_type: "DateTime",
              default_expr: "now()",
              default: "now()",
            },
            {
              name: "updatedAt",
              type: "datetime",
              required: true,
              prisma_type: "DateTime",
              auto_updated_at: true,
              default_expr: "now()",
              default: "now()",
            },
          ],
        },
      },
    ],
  };
}

async function commandInit() {
  const project = initProjectTemplate();
  const force = flag("force");
  const configBody = {
    moduleName: settings.moduleName,
    paths: {
      schema: path.relative(settings.cwd, settings.schemaPath).replace(/\\/g, "/"),
      types: path.relative(settings.cwd, settings.typesPath).replace(/\\/g, "/"),
      migrations: path.relative(settings.cwd, settings.migrationsDir).replace(/\\/g, "/"),
    },
    env: {
      url: cliConfig.env.url,
      token: cliConfig.env.token,
      username: cliConfig.env.username,
      password: cliConfig.env.password,
    },
  };

  if (!(await fileExists(settings.configPath)) || force) {
    await writeText(settings.configPath, `${JSON.stringify(configBody, null, 2)}\n`);
    process.stdout.write(`Wrote config -> ${settings.configPath}\n`);
  }

  if (!(await fileExists(settings.schemaPath)) || force) {
    await writeText(settings.schemaPath, renderSchemaFile(project));
    process.stdout.write(`Wrote schema -> ${settings.schemaPath}\n`);
  }

  await fsp.mkdir(settings.migrationsDir, { recursive: true });
  await writeGeneratedArtifacts(
    settings.typesPath,
    generateTypeDefinitions(project, { moduleName: settings.moduleName })
  );
  process.stdout.write(`Prepared generated types -> ${settings.typesPath}\n`);

  const envExamplePath = path.resolve(settings.cwd, ".env.example");
  if (!(await fileExists(envExamplePath)) || force) {
    await writeText(
      envExamplePath,
      `${cliConfig.env.url}=${DEFAULT_URL}\n${cliConfig.env.username}=admin\n${cliConfig.env.password}=admin\n${cliConfig.env.token}=\n`
    );
    process.stdout.write(`Wrote env example -> ${envExamplePath}\n`);
  }
}

async function commandGenerate() {
  const project = await resolveProjectForGenerate();
  const rendered = generateTypeDefinitions(project, { moduleName: settings.moduleName });
  await writeGeneratedArtifacts(settings.typesPath, rendered);
  process.stdout.write(`Generated ${project.models.length} model(s) -> ${settings.typesPath}\n`);
}

async function commandSchemaPull() {
  const out = path.resolve(settings.cwd, arg("out", settings.schemaPath));
  const project = await (await getClient()).schema.pull();
  await writeText(out, renderSchemaFile(project));
  process.stdout.write(`Pulled schema -> ${out}\n`);
  await autoGenerate(project);
}

async function commandSchemaPlan() {
  const project = await loadProjectFromSchemaFile(settings.schemaPath);
  const client = await getClient();
  const plan = await client.schema.plan(project, { forceDrop: flag("force-drop") });
  printPlan(plan, flag("json"));
}

async function commandSchemaPush() {
  const client = await getClient();
  const project = await loadProjectFromSchemaFile(settings.schemaPath);
  const options = {
    dryRun: flag("dry-run"),
    forceDrop: flag("force-drop"),
  };
  const plan = await client.schema.push(project, options);
  printPlan(plan, flag("json"));
  if (!options.dryRun) {
    await autoGenerate(project);
  }
}

async function commandMigrateDev() {
  const name = arg("name", "migration");
  const forceDrop = flag("force-drop");
  const createOnly = flag("create-only");
  const client = await getClient();
  const project = await loadProjectFromSchemaFile(settings.schemaPath);
  const plan = await client.schema.plan(project, { forceDrop });

  if (!plan.operations.length) {
    process.stdout.write("No schema changes.\n");
    return;
  }

  const id = migrationId(name);
  const migrationDir = path.join(settings.migrationsDir, id);
  await fsp.mkdir(migrationDir, { recursive: true });

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

  await writeText(path.join(migrationDir, "schema.schema"), renderSchemaFile(project));
  await writeText(path.join(migrationDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await writeText(path.join(migrationDir, "migration.json"), `${JSON.stringify(migration, null, 2)}\n`);

  process.stdout.write(`Created migration ${id}\n`);
  printPlan(plan, false);

  if (createOnly) {
    await autoGenerate(project);
    return;
  }

  await client.schema.push(project, { forceDrop });
  await markMigrationApplied(client, migration);
  process.stdout.write(`Applied migration ${id}\n`);
  await autoGenerate(project);
}

async function commandMigrateDeploy() {
  const client = await getClient();
  const migrations = await loadLocalMigrations(settings.migrationsDir);
  const { map } = await loadAppliedMigrations(client);

  if (!migrations.length) {
    process.stdout.write(`No migrations found in ${settings.migrationsDir}\n`);
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
    return;
  }

  await autoGenerate(await client.schema.pull());
}

async function commandMigrateStatus() {
  const client = await getClient();
  const migrations = await loadLocalMigrations(settings.migrationsDir);
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
    process.stdout.write(`No migrations found in ${settings.migrationsDir}\n`);
    return;
  }

  for (const row of rows) {
    process.stdout.write(`${row.status.padEnd(8)} ${row.id} ${row.name || ""}\n`);
  }
}

async function main() {
  const args = normalizeCommand(positional());
  const [group = "help", action = ""] = args;

  if (group === "help" || flag("help")) {
    usage();
    return;
  }

  if (group === "init") {
    await commandInit();
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
