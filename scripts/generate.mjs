#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { VoidClient, generateTypeDefinitions } from "../dist/index.mjs";

function arg(name, fallback = "") {
  const exact = `--${name}`;
  const prefixed = `${exact}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === exact) {
      return process.argv[index + 1] ?? fallback;
    }
    if (token.startsWith(prefixed)) {
      return token.slice(prefixed.length);
    }
  }
  return fallback;
}

async function main() {
  const url = arg("url", process.env.VOIDDB_URL || "http://localhost:7700");
  const output = arg("output", "voiddb.generated.d.ts");
  const token = arg("token", process.env.VOIDDB_TOKEN || "");
  const username = arg("username", process.env.VOIDDB_USERNAME || "");
  const password = arg("password", process.env.VOIDDB_PASSWORD || "");

  const client = new VoidClient({ url, token: token || undefined });
  if (!token && username && password) {
    await client.login(username, password);
  }

  const project = await client.schema.pull();
  const rendered = generateTypeDefinitions(project, {
    moduleName: arg("module", path.basename(process.cwd())),
  });

  const target = path.resolve(process.cwd(), output);
  await fs.writeFile(target, rendered, "utf8");
  process.stdout.write(`Generated ${project.models.length} model(s) -> ${target}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
