/**
 * @fileoverview VoidDB HTTP client – the core transport layer for the ORM.
 * All API calls go through this class which handles auth, retries and errors.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import type {
  VoidClientConfig,
  VoidDocument,
  QueryInput,
  QueryLike,
  QueryNode,
  QueryRows,
  QueryWhereInput,
  QuerySpec,
  QueryResult,
  TokenPair,
  VoidUser,
  EngineStats,
  CollectionSchema,
  SchemaModel,
  SchemaOperation,
  SchemaPlan,
  SchemaProject,
  SchemaPushOptions,
  TypegenOptions,
} from "./types";
import { generateTypeDefinitions } from "./codegen";

const DEFAULT_SCHEMA_DATASOURCE = {
  name: "db",
  provider: "voiddb",
  url: `env("VOIDDB_URL")`,
} as const;

const DEFAULT_SCHEMA_GENERATOR = {
  name: "client",
  provider: "voiddb-client-js",
  output: "../generated",
} as const;

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * VoidError is thrown for all API-level errors.
 */
export class VoidError extends Error {
  /** HTTP status code, if available. */
  public readonly status?: number;
  /** Raw error message from the server. */
  public readonly serverMessage?: string;

  constructor(message: string, status?: number, serverMessage?: string) {
    super(message);
    this.name = "VoidError";
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

// ── HTTP Client ───────────────────────────────────────────────────────────────

/**
 * HttpClient wraps axios and provides strongly-typed request methods.
 * It automatically attaches the Bearer token and refreshes it on 401.
 */
export class HttpClient {
  private http: AxiosInstance;
  private token: string | undefined;
  private refreshToken: string | undefined;

  constructor(config: VoidClientConfig) {
    this.token = config.token;
    this.http = axios.create({
      baseURL: config.url,
      timeout: config.timeout ?? 30_000,
    });

    // Attach token on every request.
    this.http.interceptors.request.use((cfg) => {
      if (this.token) {
        cfg.headers = cfg.headers ?? {};
        cfg.headers.Authorization = `Bearer ${this.token}`;
      }
      return cfg;
    });

    // Auto-refresh on 401.
    this.http.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        if (err.response?.status === 401 && this.refreshToken) {
          try {
            const res = await axios.post<TokenPair>(
              `${config.url}/v1/auth/refresh`,
              { refresh_token: this.refreshToken }
            );
            this.setTokens(res.data.access_token, res.data.refresh_token);
            if (err.config) {
              err.config.headers = err.config.headers ?? {};
              err.config.headers.Authorization = `Bearer ${this.token}`;
              return this.http(err.config);
            }
          } catch {
            this.token = undefined;
            this.refreshToken = undefined;
          }
        }
        return Promise.reject(this.wrapError(err));
      }
    );
  }

  /** Sets the access and refresh tokens (called after login). */
  setTokens(access: string, refresh?: string): void {
    this.token = access;
    if (refresh) this.refreshToken = refresh;
  }

  /** Returns the current access token. */
  getToken(): string | undefined {
    return this.token;
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.http.get<T>(path, { params });
    return res.data;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.http.post<T>(path, body);
    return res.data;
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.http.put<T>(path, body);
    return res.data;
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.http.patch<T>(path, body);
    return res.data;
  }

  async delete(path: string): Promise<void> {
    await this.http.delete(path);
  }

  private wrapError(err: AxiosError): VoidError {
    const data = err.response?.data as { error?: string } | undefined;
    return new VoidError(
      data?.error ?? err.message,
      err.response?.status,
      data?.error
    );
  }
}

const INTERNAL_META_DATABASE = "__void";

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function isQueryLike(value: unknown): value is QueryLike {
  return value !== null && typeof value === "object" && "toSpec" in value && typeof (value as QueryLike).toSpec === "function";
}

function isQueryNode(value: unknown): value is QueryNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if ("field" in value && "op" in value && "value" in value) {
    return true;
  }
  if ("AND" in value && Array.isArray((value as { AND?: unknown[] }).AND)) {
    return true;
  }
  if ("OR" in value && Array.isArray((value as { OR?: unknown[] }).OR)) {
    return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWhere(where: QuerySpec["where"] | QueryWhereInput | undefined): QuerySpec["where"] {
  if (!where) {
    return undefined;
  }
  if (isQueryNode(where)) {
    return where;
  }
  const entries = Object.entries(where as QueryWhereInput);
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    const [field, value] = entries[0];
    return { field, op: "eq", value };
  }
  return {
    AND: entries.map(([field, value]) => ({ field, op: "eq", value })),
  };
}

function normalizeQuery(query?: QueryInput): QuerySpec {
  if (!query) {
    return {};
  }
  if (isQueryLike(query)) {
    return query.toSpec();
  }
  if (isPlainObject(query) && !("where" in query) && !("order_by" in query) && !("include" in query) && !("limit" in query) && !("skip" in query)) {
    return { where: normalizeWhere(query as QueryWhereInput) };
  }
  const spec = query as QuerySpec;
  return {
    ...spec,
    where: normalizeWhere(spec.where),
  };
}

class QueryRowsImpl<T> extends Array<T> implements QueryRows<T> {
  constructor(rows: T[] = []) {
    super(...rows);
    Object.setPrototypeOf(this, QueryRowsImpl.prototype);
  }

  toArray(): T[] {
    return Array.from(this);
  }

  json(): T[] {
    return JSON.parse(JSON.stringify(this)) as T[];
  }

  first(): T | null {
    return this.length > 0 ? this[0] : null;
  }
}

function rowsOf<T>(rows: T[]): QueryRows<T> {
  return new QueryRowsImpl(rows);
}

function storageName(field: CollectionSchema["fields"][number]): string {
  return field.mapped_name || (field.is_id ? "_id" : field.name);
}

function toPascal(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function defaultModelName(database: string, collection: string): string {
  const base = toPascal(collection) || "Model";
  if (!database || database === "default") {
    return base;
  }
  return `${toPascal(database)}${base}`;
}

function uniqueModelName(name: string, used: Map<string, number>): string {
  const seen = used.get(name) ?? 0;
  if (seen === 0) {
    used.set(name, 1);
    return name;
  }
  const next = seen + 1;
  used.set(name, next);
  return `${name}${next}`;
}

function normalizeSchema(schema: CollectionSchema): CollectionSchema {
  const normalized: CollectionSchema = {
    database: schema.database,
    collection: schema.collection,
    model: schema.model,
    fields: (schema.fields ?? []).map((field) => {
      const next = {
        name: field.name,
        type: field.type,
        required: field.required,
        default: field.default,
        default_expr: field.default_expr,
        prisma_type: field.prisma_type,
        unique: field.unique || undefined,
        is_id: field.is_id || undefined,
        list: field.list || undefined,
        auto_updated_at: field.auto_updated_at || undefined,
        mapped_name: field.mapped_name,
        relation: field.relation
          ? {
              model: field.relation.model,
              fields: field.relation.fields ? [...field.relation.fields] : undefined,
              references: field.relation.references ? [...field.relation.references] : undefined,
              on_delete: field.relation.on_delete,
              on_update: field.relation.on_update,
              name: field.relation.name,
            }
          : undefined,
      };
      if (next.is_id && !next.mapped_name && next.name !== "_id") {
        next.mapped_name = "_id";
      }
      return next;
    }),
    indexes: (schema.indexes ?? []).map((index) => ({
      ...index,
      fields: [...index.fields],
    })),
  };

  normalized.fields.sort((left, right) =>
    storageName(left).localeCompare(storageName(right))
  );
  normalized.indexes?.sort((left, right) => {
    const leftKey = `${left.fields.join(",")}|${left.name ?? ""}`;
    const rightKey = `${right.fields.join(",")}|${right.name ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });

  return normalized;
}

function canonicalSchema(schema: CollectionSchema): string {
  return JSON.stringify(normalizeSchema(schema));
}

function projectModelMap(project: SchemaProject): Map<string, SchemaModel> {
  const out = new Map<string, SchemaModel>();
  for (const model of project.models ?? []) {
    const schema = normalizeSchema(model.schema);
    const database = schema.database ?? "default";
    const collection = schema.collection ?? model.name;
    out.set(`${database}/${collection}`, {
      name: model.name,
      schema: {
        ...schema,
        database,
        collection,
      },
    });
  }
  return out;
}

function projectDatabaseSet(project: SchemaProject): Set<string> {
  const out = new Set<string>();
  for (const model of project.models ?? []) {
    const database = model.schema.database;
    if (database) {
      out.add(database);
    }
  }
  return out;
}

function planSchemaDiff(
  current: SchemaProject,
  desired: SchemaProject,
  forceDrop = false
): SchemaPlan {
  const currentModels = projectModelMap(current);
  const desiredModels = projectModelMap(desired);
  const currentDBs = projectDatabaseSet(current);
  const desiredDBs = projectDatabaseSet(desired);
  const operations: SchemaOperation[] = [];
  const createdDatabases = new Set<string>();

  for (const key of Array.from(desiredModels.keys()).sort()) {
    const desiredModel = desiredModels.get(key)!;
    const schema = normalizeSchema(desiredModel.schema);
    const database = schema.database!;
    const collection = schema.collection!;

    if (!currentDBs.has(database) && !createdDatabases.has(database)) {
      createdDatabases.add(database);
      operations.push({
        type: "create_database",
        database,
        summary: `create database ${database}`,
      });
    }

    const existing = currentModels.get(key);
    if (!existing) {
      operations.push({
        type: "create_collection",
        database,
        collection,
        summary: `create collection ${database}/${collection}`,
      });
      operations.push({
        type: "set_schema",
        database,
        collection,
        schema,
        summary: `set schema ${database}/${collection}`,
      });
      continue;
    }

    if (canonicalSchema(existing.schema) !== canonicalSchema(schema)) {
      operations.push({
        type: "set_schema",
        database,
        collection,
        schema,
        summary: `update schema ${database}/${collection}`,
      });
    }
  }

  if (forceDrop) {
    for (const key of Array.from(currentModels.keys()).sort()) {
      if (desiredModels.has(key)) {
        continue;
      }
      const schema = normalizeSchema(currentModels.get(key)!.schema);
      if (!desiredDBs.has(schema.database!)) {
        continue;
      }
      operations.push({
        type: "delete_collection",
        database: schema.database!,
        collection: schema.collection!,
        summary: `drop collection ${schema.database}/${schema.collection}`,
      });
    }
  }

  return { operations };
}

/**
 * Cache provides a tiny typed wrapper around VoidDB's KV cache endpoints.
 */
export class Cache {
  constructor(private readonly http: HttpClient) {}

  async get<T = string>(key: string): Promise<T | null> {
    try {
      const res = await this.http.get<{ value?: string }>(
        `/v1/cache/${encodeURIComponent(key)}`
      );
      if (res.value === undefined || res.value === null) {
        return null;
      }
      try {
        return JSON.parse(res.value) as T;
      } catch {
        return res.value as T;
      }
    } catch (err) {
      if (err instanceof VoidError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload: { value: string; ttl?: number } = {
      value: typeof value === "string" ? value : JSON.stringify(value),
    };
    if (ttlSeconds !== undefined) {
      payload.ttl = ttlSeconds;
    }
    await this.http.post(`/v1/cache/${encodeURIComponent(key)}`, payload);
  }

  async delete(key: string): Promise<void> {
    await this.http.delete(`/v1/cache/${encodeURIComponent(key)}`);
  }
}

// ── Collection ────────────────────────────────────────────────────────────────

/**
 * Collection provides CRUD operations for a single VoidDB collection.
 *
 * @template T - The document shape (must include _id: string).
 */
export class Collection<T extends {
  _id: string;
} = VoidDocument> {
  constructor(
    private readonly http: HttpClient,
    private readonly db: string,
    private readonly name: string
  ) {}

  /** Returns the collection path segment. */
  private path(id?: string): string {
    const base = `/v1/databases/${this.db}/${this.name}`;
    return id ? `${base}/${id}` : base;
  }

  /**
   * Inserts a new document and returns the generated _id.
   *
   * @param doc - Fields to insert (without _id, or with a custom _id).
   */
  async insert(doc: Omit<T, "_id"> & { _id?: string }): Promise<string> {
    const res = await this.http.post<{ _id: string }>(this.path(), doc);
    return res._id;
  }

  /**
   * Retrieves a document by its _id.
   *
   * @throws VoidError with status 404 if not found.
   */
  async findById(id: string): Promise<T> {
    return this.http.get<T>(this.path(id));
  }

  /**
   * Alias for findById() for users who prefer a shorter CRUD verb.
   */
  async get(id: string): Promise<T> {
    return this.findById(id);
  }

  /**
   * Finds all documents matching the given query spec.
   *
   * @param query - A QuerySpec or a QueryBuilder (call .toSpec() automatically).
   */
  async find(query?: QueryInput): Promise<QueryRows<T>> {
    const spec = normalizeQuery(query);
    const res = await this.http.post<QueryResult<T>>(
      `${this.path()}/query`,
      spec
    );
    return rowsOf(res.results);
  }

  /**
   * Alias for find() for codebases that prefer `.query(...)`.
   */
  async query(query?: QueryInput): Promise<QueryRows<T>> {
    return this.find(query);
  }

  /**
   * Typed variant of find() for queries that use relation includes.
   */
  async findWithRelations<TRelations extends Record<string, unknown> = Record<string, never>>(
    query?: QueryInput
  ): Promise<QueryRows<T & TRelations>> {
    const rows = await this.find(query);
    return rows as QueryRows<T & TRelations>;
  }

  /**
   * Like find() but returns both the result array and the total count
   * (before limit/skip) for pagination.
   */
  async findWithCount(
    query?: QueryInput
  ): Promise<QueryResult<T>> {
    const spec = normalizeQuery(query);
    return this.http.post<QueryResult<T>>(`${this.path()}/query`, spec);
  }

  /**
   * Alias for findWithCount() for codebases that prefer `.queryWithCount(...)`.
   */
  async queryWithCount(query?: QueryInput): Promise<QueryResult<T>> {
    return this.findWithCount(query);
  }

  /**
   * Typed variant of findWithCount() for include-heavy queries.
   */
  async findWithRelationsAndCount<TRelations extends Record<string, unknown> = Record<string, never>>(
    query?: QueryInput
  ): Promise<QueryResult<T & TRelations>> {
    const result = await this.findWithCount(query);
    return result as QueryResult<T & TRelations>;
  }

  /**
   * Returns the count of documents matching query (or all documents).
   */
  async count(
    query?: QueryInput
  ): Promise<number> {
    if (!query) {
      const res = await this.http.get<{ count: number }>(`${this.path()}/count`);
      return res.count;
    }
    const spec = normalizeQuery(query);
    const res = await this.http.post<QueryResult<T>>(`${this.path()}/query`, spec);
    return res.count;
  }

  /**
   * Alias for count(query?) kept for readability in some call sites.
   */
  async countMatching(
    query?: QueryInput
  ): Promise<number> {
    return this.count(query);
  }

  /**
   * Fully replaces the document with the given id.
   */
  async replace(id: string, doc: Omit<T, "_id">): Promise<void> {
    await this.http.put(this.path(id), doc);
  }

  /**
   * Alias for replace() for users who prefer HTTP-style naming.
   */
  async put(id: string, doc: Omit<T, "_id">): Promise<void> {
    await this.replace(id, doc);
  }

  /**
   * Partially updates a document (merges fields).
   *
   * @returns The updated document.
   */
  async patch(id: string, patch: Partial<Omit<T, "_id">>): Promise<T> {
    return this.http.patch<T>(this.path(id), patch);
  }

  /**
   * Deletes the document with the given id.
   */
  async delete(id: string): Promise<void> {
    await this.http.delete(this.path(id));
  }

  /**
   * Returns the collection schema metadata.
   */
  async getSchema(): Promise<CollectionSchema> {
    return this.http.get<CollectionSchema>(`${this.path()}/schema`);
  }

  /**
   * Replaces the collection schema metadata.
   */
  async setSchema(schema: CollectionSchema): Promise<CollectionSchema> {
    return this.http.put<CollectionSchema>(`${this.path()}/schema`, schema);
  }
}

// ── Database ──────────────────────────────────────────────────────────────────

/**
 * Database provides access to collections within a named database.
 */
export class Database {
  constructor(
    private readonly http: HttpClient,
    private readonly name: string
  ) {}

  /**
   * Returns a typed Collection handle.
   *
   * @param name - Collection name.
   *
   * @example
   * const users = db.collection<UserDoc>('users')
   */
  collection<T extends {
    _id: string;
  } = VoidDocument>(name: string): Collection<T> {
    return new Collection<T>(this.http, this.name, name);
  }

  /**
   * Lists all collection names in this database.
   */
  async listCollections(): Promise<string[]> {
    const res = await this.http.get<{ collections: string[] }>(
      `/v1/databases/${this.name}/collections`
    );
    return res.collections ?? [];
  }

  /**
   * Explicitly creates a collection (collections are also created implicitly on first insert).
   */
  async createCollection(name: string): Promise<void> {
    await this.http.post(`/v1/databases/${this.name}/collections`, { name });
  }

  /**
   * Drops a collection from the database.
   */
  async dropCollection(name: string): Promise<void> {
    await this.http.delete(
      `/v1/databases/${pathSegment(this.name)}/collections/${pathSegment(name)}`
    );
  }
}

/**
 * SchemaManager provides structured schema pull/push helpers for SDK users.
 */
export class SchemaManager {
  constructor(private readonly http: HttpClient) {}

  async pull(): Promise<SchemaProject> {
    const res = await this.http.get<{ databases: string[] }>("/v1/databases");
    const usedNames = new Map<string, number>();
    const models: SchemaModel[] = [];

    for (const database of res.databases ?? []) {
      if (database === INTERNAL_META_DATABASE) {
        continue;
      }
      const collections = await this.http.get<{ collections: string[] }>(
        `/v1/databases/${pathSegment(database)}/collections`
      );
      for (const collection of collections.collections ?? []) {
        const schema = await this.http.get<CollectionSchema>(
          `/v1/databases/${pathSegment(database)}/${pathSegment(collection)}/schema`
        );
        schema.database = database;
        schema.collection = collection;
        schema.model = uniqueModelName(
          schema.model || defaultModelName(database, collection),
          usedNames
        );
        models.push({
          name: schema.model,
          schema,
        });
      }
    }

    return {
      datasource: { ...DEFAULT_SCHEMA_DATASOURCE },
      generator: { ...DEFAULT_SCHEMA_GENERATOR },
      models,
    };
  }

  async plan(
    project: SchemaProject,
    options: SchemaPushOptions = {}
  ): Promise<SchemaPlan> {
    const current = await this.pull();
    return planSchemaDiff(current, project, options.forceDrop ?? false);
  }

  async push(
    project: SchemaProject,
    options: SchemaPushOptions = {}
  ): Promise<SchemaPlan> {
    const plan = await this.plan(project, options);
    if (options.dryRun) {
      return plan;
    }

    for (const op of plan.operations) {
      switch (op.type) {
        case "create_database":
          await this.http.post("/v1/databases", { name: op.database });
          break;
        case "delete_database":
          await this.http.delete(`/v1/databases/${pathSegment(op.database)}`);
          break;
        case "create_collection":
          await this.http.post(
            `/v1/databases/${pathSegment(op.database)}/collections`,
            { name: op.collection }
          );
          break;
        case "delete_collection":
          await this.http.delete(
            `/v1/databases/${pathSegment(op.database)}/collections/${pathSegment(op.collection!)}`
          );
          break;
        case "set_schema":
          await this.http.put(
            `/v1/databases/${pathSegment(op.database)}/${pathSegment(op.collection!)}/schema`,
            op.schema
          );
          break;
      }
    }

    return plan;
  }

  async generateTypes(options: TypegenOptions = {}): Promise<string> {
    const project = await this.pull();
    return generateTypeDefinitions(project, options);
  }
}

// ── VoidClient ────────────────────────────────────────────────────────────────

/**
 * VoidClient is the main entry point for the VoidDB TypeScript ORM.
 *
 * @example
 * const client = new VoidClient({ url: 'http://localhost:7700', token: '...' })
 * const db = client.database('myapp')
 * const users = db.collection('users')
 */
export class VoidClient {
  private readonly http: HttpClient;
  public readonly cache: Cache;
  public readonly schema: SchemaManager;

  /**
   * Creates a client from environment variables.
   * Uses VOIDDB_URL and VOIDDB_TOKEN by default.
   */
  static fromEnv(config: Partial<VoidClientConfig> = {}): VoidClient {
    return new VoidClient({
      url: config.url ?? process.env.VOIDDB_URL ?? process.env.VOID_URL ?? "http://localhost:7700",
      token: config.token ?? process.env.VOIDDB_TOKEN ?? process.env.VOID_TOKEN,
      timeout: config.timeout,
    });
  }

  constructor(config: VoidClientConfig) {
    this.http = new HttpClient(config);
    this.cache = new Cache(this.http);
    this.schema = new SchemaManager(this.http);
  }

  /**
   * Authenticates the client with username and password.
   * Stores the resulting tokens internally for future requests.
   *
   * @returns The raw token pair (you may persist these yourself).
   */
  async login(username: string, password: string): Promise<TokenPair> {
    const res = await this.http.post<TokenPair>("/v1/auth/login", {
      username,
      password,
    });
    this.http.setTokens(res.access_token, res.refresh_token);
    return res;
  }

  /**
   * Returns a Database handle for the given name.
   */
  database(name: string): Database {
    return new Database(this.http, name);
  }

  /**
   * Alias for database() kept for compatibility with older examples.
   */
  db(name: string): Database {
    return this.database(name);
  }

  /**
   * Lists all database names on the server.
   */
  async listDatabases(): Promise<string[]> {
    const res = await this.http.get<{ databases: string[] }>("/v1/databases");
    return res.databases ?? [];
  }

  /**
   * Creates a new database.
   */
  async createDatabase(name: string): Promise<void> {
    await this.http.post("/v1/databases", { name });
  }

  /**
   * Drops a database.
   */
  async dropDatabase(name: string): Promise<void> {
    await this.http.delete(`/v1/databases/${pathSegment(name)}`);
  }

  /**
   * Returns the current authenticated user.
   */
  async me(): Promise<VoidUser> {
    return this.http.get<VoidUser>("/v1/auth/me");
  }

  /**
   * Returns engine-level statistics.
   */
  async stats(): Promise<EngineStats> {
    return this.http.get<EngineStats>("/v1/stats");
  }

  /**
   * Returns the raw token for use in other clients (e.g. S3 SDK).
   */
  getToken(): string | undefined {
    return this.http.getToken();
  }
}
