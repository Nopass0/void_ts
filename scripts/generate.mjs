#!/usr/bin/env node

process.argv.splice(2, 0, "generate");
await import(new URL("./cli.mjs", import.meta.url));
