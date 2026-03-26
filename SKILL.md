# VoidDB TypeScript ORM Skill

Use this skill when you need to write, update, or review TypeScript code that integrates with `@voiddb/orm`.

## What this package is

`@voiddb/orm` is the official TypeScript ORM and schema CLI for VoidDB.

It provides:

- `VoidClient` for HTTP access to VoidDB
- `query()` for fluent query building
- `vdb` CLI for schema pull/push, migrations, and type generation
- generated model types in `.voiddb/generated`
- direct upload/delete helpers for `Blob` document fields

## Install

```bash
npm install @voiddb/orm
```

or

```bash
bun add @voiddb/orm
```

For CLI usage inside a project:

```bash
npm install -D @voiddb/orm
```

## Environment variables

The CLI and `VoidClient.fromEnv()` use:

```env
VOIDDB_URL=https://db.lowkey.su
VOIDDB_USERNAME=admin
VOIDDB_PASSWORD=your-password
```

Alternative token-based auth:

```env
VOIDDB_URL=https://db.lowkey.su
VOIDDB_TOKEN=your-jwt-token
```

Optional overrides:

```env
VOIDDB_MODULE=my-app
VOIDDB_SCHEMA=.voiddb/schema/app.schema
VOIDDB_TYPES=.voiddb/generated/voiddb.generated.d.ts
VOIDDB_MIGRATIONS=.voiddb/migrations
```

The CLI automatically reads:

- `.env`
- `.env.local`
- `.voiddb/.env`
- `.voiddb/config.json`

## Project bootstrap

Scaffold the local structure with:

```bash
npx --package=@voiddb/orm vdb init
```

This creates:

```text
.voiddb/
  config.json
  schema/
    app.schema
  generated/
    voiddb.generated.d.ts
    index.d.ts
    index.js
  migrations/
```

## Schema workflow

Default schema file extension is `.schema`.

Preferred format:

```prisma
datasource db {
  provider = "voiddb"
  url      = env("VOIDDB_URL")
}

generator client {
  provider = "voiddb-client-js"
  output   = "../generated"
}

database {
  name = "app"

  model User {
    id String @id
    email String @unique
    name String
    createdAt DateTime @default(now())
    updatedAt DateTime @default(now()) @updatedAt
    @@map("users")
  }
}
```

The parser is backward-compatible with older top-level `model` blocks.

## CLI commands

Short commands:

```bash
npx vdb init
npx vdb pull
npx vdb push
npx vdb gen
npx vdb dev --name add_users
npx vdb status
npx vdb deploy
```

One-off execution without local install:

```bash
npx --package=@voiddb/orm vdb pull
bunx --package @voiddb/orm vdb dev --name add_users
```

Long commands still work:

```bash
npx --package=@voiddb/orm voiddb-orm schema pull
npx --package=@voiddb/orm voiddb-orm migrate status
```

Type generation runs automatically after:

- `vdb pull`
- `vdb push`
- `vdb dev`
- `vdb deploy`

Schema sync is scoped to databases explicitly declared in the schema file.
Databases not mentioned in the schema must remain untouched.

Skip auto-generation with:

```bash
vdb push --no-generate
```

## Runtime usage

Basic client:

```ts
import { VoidClient, query } from "@voiddb/orm";

const client = VoidClient.fromEnv();
await client.login(process.env.VOIDDB_USERNAME!, process.env.VOIDDB_PASSWORD!);

const users = client.db("app").collection<User>("users");

const rows = await users.find(
  query()
    .where("active", "eq", true)
    .orderBy("createdAt", "desc")
    .limit(20)
);
```

Generated model types can be used directly without `& VoidDocument`:

```ts
import type { LowkeyUsers } from "./.voiddb/generated";

const users = client.db("lowkey").collection<LowkeyUsers>("users");
```

Token-based client:

```ts
const client = new VoidClient({
  url: process.env.VOIDDB_URL!,
  token: process.env.VOIDDB_TOKEN!,
});
```

## Query builder

Use `query()` for fluent queries:

```ts
const built = query()
  .where("age", "gte", 18)
  .orderBy("name")
  .limit(10);
```

For raw payload access:

```ts
const payload = built.json();
const asString = built.stringify();
```

Equality shorthand is supported too:

```ts
const rows = await users.find({
  where: {
    isAdmin: false,
  },
});
```

`.query()` is an alias for `.find()`:

```ts
const rows = await users.query({
  where: {
    isAdmin: false,
  },
});
```

`find()` returns an array-like result with helper methods:

```ts
const rows = await users.find({ where: { isAdmin: false } });
const first = rows.first();
const plain = rows.toArray();
const json = rows.json();
```

## Generated types

Generated types live in:

- `.voiddb/generated/voiddb.generated.d.ts`
- `.voiddb/generated/index.d.ts`

Recommended import:

```ts
import type {
  VoidDbGeneratedCollections,
  VoidDbGeneratedCollectionsByPath,
  VoidDbGeneratedDatabases,
  VoidDbCollectionModel,
  User,
  UserCreateInput,
} from "./.voiddb/generated";
```

### Which generated type to use

Use one of these depending on your need:

1. Exact collection inside a known database:

```ts
type LowkeyUser = VoidDbGeneratedDatabases["lowkey"]["users"];
```

2. Collection name regardless of database:

```ts
type AnyUsersCollection = VoidDbGeneratedCollections["users"];
```

If the same collection name exists in multiple databases, this becomes a union.

3. Exact database/collection path:

```ts
type ExactLowkeyUser = VoidDbGeneratedCollectionsByPath["lowkey/users"];
```

### Practical usage

Preferred exact usage:

```ts
const users = client
  .database("lowkey")
  .collection<VoidDbGeneratedDatabases["lowkey"]["users"]>("users");
```

If you only care about collection name:

```ts
const users = client
  .database("lowkey")
  .collection<VoidDbGeneratedCollections["users"]>("users");
```

## Relation includes

Use `query().include(...)`:

```ts
const rows = await client
  .db("app")
  .collection("users")
  .findWithRelations<{
    profile: { _id: string; bio: string };
  }>(
    query()
      .where("_id", "eq", "user-1")
      .include({
        as: "profile",
        relation: "many_to_one",
        target_col: "profiles",
        local_key: "profile_id",
        foreign_key: "_id",
      })
  );
```

## Cache API

```ts
await client.cache.set("session:alice", { ok: true }, 3600);
const session = await client.cache.get("session:alice");
await client.cache.delete("session:alice");
```

## Blob fields and uploads

`Blob` is a first-class schema field type. The ORM can upload a file directly into a document field:

```ts
const assets = client.db("media").collection<MediaAssets>("assets");

const ref = await assets.uploadFile(
  "asset-123",
  "original",
  new TextEncoder().encode("hello"),
  {
    filename: "hello.txt",
    contentType: "text/plain",
  }
);

console.log(ref._blob_url);
console.log(assets.blobUrl(ref));
```

Delete the field-backed object with:

```ts
await assets.deleteFile("asset-123", "original");
```

## Agent rules

When generating code with this package:

- prefer `VoidClient.fromEnv()` for app code unless the user explicitly wants inline config
- prefer generated types from `./.voiddb/generated`
- prefer `VoidDbGeneratedDatabases["db"]["collection"]` when database name is known
- use `VoidDbGeneratedCollections["collection"]` only when cross-database unions are acceptable
- use `query().json()` when you need to inspect or log the exact server payload
- prefer `uploadFile()` over manually patching `_blob_bucket` / `_blob_key` unless the caller explicitly wants custom low-level control
- prefer `vdb` short commands in docs and examples
- use `.schema` files, not `.prisma`, for new projects
- keep examples aligned with actual runtime signatures of the package

## Common pitfalls

- `npx voiddb-orm ...` does not work for one-off remote execution of a scoped package.
  Use:

```bash
npx --package=@voiddb/orm vdb pull
```

- `VoidDbGeneratedCollections["users"]` can be a union if multiple databases contain a `users` collection.
- Generated types update only after `vdb gen` or the auto-generation commands listed above.

## References

- npm: https://www.npmjs.com/package/@voiddb/orm
- repo: https://github.com/Nopass0/void_ts
- core server: https://github.com/Nopass0/void
