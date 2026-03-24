# `@voiddb/orm`

Official TypeScript client for VoidDB.

## Install

```bash
npm install @voiddb/orm
```

## Quick Start

```ts
import { VoidClient, query } from "@voiddb/orm";

interface User {
  _id: string;
  name: string;
  age: number;
  active: boolean;
}

const client = new VoidClient({ url: "http://localhost:7700" });
await client.login("admin", "admin");

const db = client.database("myapp");
await client.createDatabase("myapp");
await db.createCollection("users");

const users = db.collection<User>("users");

const id = await users.insert({
  name: "Alice",
  age: 30,
  active: true,
});

const found = await users.find(
  query()
    .where("age", "gte", 18)
    .where("active", "eq", true)
    .orderBy("name", "asc")
    .limit(25)
);

const alice = await users.get(id);
await users.patch(id, { age: 31 });
await users.put(id, { name: "Alice", age: 31, active: true });
await users.delete(id);

await client.cache.set("session:alice", { active: true }, 3600);
const session = await client.cache.get<{ active: boolean }>("session:alice");
```

## API Surface

- `VoidClient`
- `client.login(username, password)`
- `client.database(name)` / `client.db(name)`
- `db.collection<T>(name)`
- `collection.insert(doc)`
- `collection.find(query?)`
- `collection.findById(id)` / `collection.get(id)`
- `collection.patch(id, patch)`
- `collection.replace(id, doc)` / `collection.put(id, doc)`
- `collection.count()`
- `collection.countMatching(query)`
- `client.cache.get(key)`
- `client.cache.set(key, value, ttlSeconds?)`
- `client.cache.delete(key)`

## AI Agent Guide

If you are integrating AI agents with a running VoidDB server, check the server-exposed guide:

- `http://<your-voiddb-host>/skill.md`

That markdown explains auth, document queries, cache, blob usage, and safe defaults for automated agents.
