/**
 * @fileoverview VoidDB HTTP client – the core transport layer for the ORM.
 * All API calls go through this class which handles auth, retries and errors.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import type {
  VoidClientConfig,
  VoidDocument,
  QuerySpec,
  QueryResult,
  TokenPair,
  VoidUser,
  EngineStats,
} from "./types";

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
export class Collection<T extends VoidDocument = VoidDocument> {
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
  async find(query?: QuerySpec | { toSpec(): QuerySpec }): Promise<T[]> {
    const spec = query
      ? "toSpec" in query
        ? query.toSpec()
        : query
      : {};
    const res = await this.http.post<QueryResult<T>>(
      `${this.path()}/query`,
      spec
    );
    return res.results;
  }

  /**
   * Like find() but returns both the result array and the total count
   * (before limit/skip) for pagination.
   */
  async findWithCount(
    query?: QuerySpec | { toSpec(): QuerySpec }
  ): Promise<QueryResult<T>> {
    const spec = query
      ? "toSpec" in query
        ? query.toSpec()
        : query
      : {};
    return this.http.post<QueryResult<T>>(`${this.path()}/query`, spec);
  }

  /**
   * Returns the count of documents matching query (or all documents).
   */
  async count(
    query?: QuerySpec | { toSpec(): QuerySpec }
  ): Promise<number> {
    if (!query) {
      const res = await this.http.get<{ count: number }>(`${this.path()}/count`);
      return res.count;
    }
    const spec = "toSpec" in query ? query.toSpec() : query;
    const res = await this.http.post<QueryResult<T>>(`${this.path()}/query`, spec);
    return res.count;
  }

  /**
   * Alias for count(query?) kept for readability in some call sites.
   */
  async countMatching(
    query?: QuerySpec | { toSpec(): QuerySpec }
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
  collection<T extends VoidDocument = VoidDocument>(name: string): Collection<T> {
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

  constructor(config: VoidClientConfig) {
    this.http = new HttpClient(config);
    this.cache = new Cache(this.http);
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
