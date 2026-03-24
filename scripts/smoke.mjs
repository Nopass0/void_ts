import { VoidClient, query } from "../dist/index.mjs";

const url = process.env.VOID_URL || "http://127.0.0.1:7716";
const username = process.env.VOID_USER || "admin";
const password = process.env.VOID_PASSWORD || "admin";

async function main() {
  const client = new VoidClient({ url });
  await client.login(username, password);

  const suffix = Date.now();
  const dbName = `smoke_ts_${suffix}`;
  const colName = "users";

  await client.createDatabase(dbName);
  const db = client.db(dbName);
  await db.createCollection(colName);
  const users = db.collection(colName);

  const id = await users.insert({ name: "Alice", age: 30, active: true });
  const fetched = await users.get(id);
  const found = await users.find(
    query()
      .where("age", "gte", 18)
      .where("active", "eq", true)
      .orderBy("name")
      .limit(10)
  );
  const patched = await users.patch(id, { age: 31 });
  const count = await users.count(query().where("active", "eq", true));

  await client.cache.set(`smoke:${dbName}`, { ok: true }, 60);
  const cached = await client.cache.get(`smoke:${dbName}`);
  await client.cache.delete(`smoke:${dbName}`);

  const skillResponse = await fetch(`${url}/skill.md`);
  const skillText = await skillResponse.text();

  await users.delete(id);
  const countAfterDelete = await users.count();

  console.log(
    JSON.stringify(
      {
        url,
        dbName,
        id,
        fetched,
        foundCount: found.length,
        patched,
        count,
        cached,
        countAfterDelete,
        skillStatus: skillResponse.status,
        skillHasQueryDSL: skillText.includes("Query DSL"),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
