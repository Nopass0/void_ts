<p align="center">
  <img src="./docs/assets/voiddb-orm-logo.svg" alt="VoidDB ORM" width="760">
</p>

<p align="center">
  <strong>Official TypeScript ORM for VoidDB.</strong><br>
  Type-safe collections, query builder, relation includes, schema pull/push, migrations, and generated model types.
</p>

<p align="center">
  <a href="https://nopass0.github.io/void_ts/">Docs</a> |
  <a href="https://github.com/Nopass0/void">Core VoidDB Server</a> |
  <a href="https://nopass0.github.io/void/">Server Docs</a>
</p>

## Why This ORM

`@voiddb/orm` is designed to feel productive in the same places Prisma feels productive:

- typed collection access
- composable query builder
- generated model definitions from live schema
- schema pull / push / diff workflows
- relation-aware fetch helpers
- simple auth and cache APIs

It stays close to the VoidDB HTTP API, so you can debug requests easily and still keep a clean developer experience.

## Install

```bash
npm install @voiddb/orm
```

or

```bash
bun add @voiddb/orm
```

## Quick Start

```ts
import { VoidClient, query } from "@voiddb/orm";

type User = {
  _id: string;
  name: string;
  age: number;
  active: boolean;
};

const client = new VoidClient({ url: "http://localhost:7700" });
await client.login("admin", "admin");

const db = client.db("app");
const users = db.collection<User>("users");

const id = await users.insert({
  name: "Alice",
  age: 30,
  active: true,
});

const result = await users.find(
  query()
    .where("age", "gte", 18)
    .where("active", "eq", true)
    .orderBy("name", "asc")
    .limit(25)
);

await users.patch(id, { age: 31 });
await users.delete(id);
```

## Schema Pull, Push, And Diff

```ts
const project = await client.schema.pull();
const plan = await client.schema.plan(project, { dryRun: true });

for (const op of plan.operations) {
  console.log(op.summary);
}

await client.schema.push(project, { forceDrop: false });
```

This is designed to pair with the core `voidcli` workflow:

```bash
voidcli schema pull --out void.prisma
voidcli schema push --schema void.prisma
voidcli migrate dev --schema void.prisma --name add_users
```

## Generate TypeScript Types

Generate model types directly from a live VoidDB server:

```ts
const project = await client.schema.pull();
const dts = client.schema.generateTypes(project, {
  moduleName: "@acme/void-models",
});

console.log(dts);
```

Or use the CLI shipped with the package:

```bash
npx voiddb-orm \
  --url http://localhost:7700 \
  --username admin \
  --password admin \
  --output ./src/generated/voiddb-models.d.ts
```

## Query Builder

```ts
const adults = await users.find(
  query()
    .where("age", "gte", 18)
    .where("active", "eq", true)
    .orderBy("created_at", "desc")
    .limit(50)
);
```

## Relation Includes

You can fetch linked documents in one call when your schema exposes relation metadata:

```ts
const result = await client
  .db("app")
  .collection("users")
  .findWithRelations<{
    profile: { _id: string; bio: string };
  }>(
    query().where("_id", "eq", "user-1"),
    [
      {
        as: "profile",
        relation: "many_to_one",
        target_col: "profiles",
        local_key: "profile_id",
        foreign_key: "_id",
      },
    ]
  );
```

## Cache API

```ts
await client.cache.set("session:alice", { loggedIn: true }, 3600);
const session = await client.cache.get<{ loggedIn: boolean }>("session:alice");
await client.cache.delete("session:alice");
```

## Documentation

- ORM docs: [nopass0.github.io/void_ts](https://nopass0.github.io/void_ts/)
- Core server repo: [Nopass0/void](https://github.com/Nopass0/void)
- Core server docs: [nopass0.github.io/void](https://nopass0.github.io/void/)
- AI agent guide exposed by running servers: `http://<host>/skill.md`

## Ecosystem Links

- VoidDB server: [github.com/Nopass0/void](https://github.com/Nopass0/void)
- Go SDK: [github.com/Nopass0/void/tree/main/orm/go](https://github.com/Nopass0/void/tree/main/orm/go)

## License

MIT
