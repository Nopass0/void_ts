/**
 * @fileoverview Core type definitions for the VoidDB TypeScript ORM.
 * These types mirror the VoidDB wire format and query DSL.
 */

// ── Value types ───────────────────────────────────────────────────────────────

/** A scalar value stored in a VoidDB document field. */
export type VoidValue =
  | null
  | string
  | number
  | boolean
  | VoidValue[]
  | { [key: string]: VoidValue }
  | BlobRef;

/** A reference to an object in the blob store. */
export interface BlobRef {
  _blob_bucket: string;
  _blob_key: string;
  _blob_url?: string;
  content_type?: string;
  etag?: string;
  size?: number;
  last_modified?: string;
  metadata?: Record<string, string>;
}

/** A raw document as returned by the API (always includes _id). */
export interface VoidDocument {
  _id: string;
  [field: string]: VoidValue;
}

// Schema sync

export type SchemaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "datetime"
  | "array"
  | "object"
  | "blob"
  | "relation";

export interface SchemaRelation {
  model?: string;
  fields?: string[];
  references?: string[];
  on_delete?: string;
  on_update?: string;
  name?: string;
}

export interface SchemaIndex {
  name?: string;
  fields: string[];
  unique?: boolean;
  primary?: boolean;
}

export interface SchemaField {
  name: string;
  type: SchemaFieldType;
  required?: boolean;
  default?: string;
  default_expr?: string;
  prisma_type?: string;
  unique?: boolean;
  is_id?: boolean;
  list?: boolean;
  virtual?: boolean;
  auto_updated_at?: boolean;
  mapped_name?: string;
  relation?: SchemaRelation;
}

export interface SchemaDatasource {
  name: string;
  provider: string;
  url: string;
}

export interface SchemaGenerator {
  name: string;
  provider: string;
  output?: string;
}

export interface CollectionSchema {
  database?: string;
  collection?: string;
  model?: string;
  fields: SchemaField[];
  indexes?: SchemaIndex[];
}

export interface SchemaModel {
  name: string;
  schema: CollectionSchema;
}

export interface SchemaProject {
  datasource?: SchemaDatasource;
  generator?: SchemaGenerator;
  models: SchemaModel[];
}

export type SchemaOperationType =
  | "create_database"
  | "delete_database"
  | "create_collection"
  | "delete_collection"
  | "set_schema";

export interface SchemaOperation {
  type: SchemaOperationType;
  database: string;
  collection?: string;
  schema?: CollectionSchema;
  summary: string;
}

export interface SchemaPlan {
  operations: SchemaOperation[];
}

export interface SchemaPushOptions {
  dryRun?: boolean;
  forceDrop?: boolean;
}

export interface BlobUploadOptions {
  filename?: string;
  contentType?: string;
  bucket?: string;
  key?: string;
  metadata?: Record<string, string>;
}

export type BlobSource =
  | string
  | ArrayBuffer
  | Uint8Array
  | Blob;

// ── Query DSL ─────────────────────────────────────────────────────────────────

/** Supported comparison operators. */
export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "in";

/** Sort direction. */
export type SortDir = "asc" | "desc";

/** A single WHERE clause filter. */
export interface FilterClause {
  field: string;
  op: FilterOp;
  value: VoidValue;
}

/** A nested query tree accepted by the VoidDB server. */
export type QueryNode =
  | FilterClause
  | { AND: QueryNode[] }
  | { OR: QueryNode[] };

/** A sort specification. */
export interface SortClause {
  field: string;
  dir: SortDir;
}

export interface IncludeClause {
  as: string;
  relation: "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
  target_col: string;
  local_key: string;
  foreign_key: string;
}

/** Shorthand equality object accepted in `where`, e.g. `{ isAdmin: false }`. */
export interface QueryWhereInput {
  [field: string]: VoidValue;
}

/** The complete query specification sent to the server. */
export interface QuerySpec {
  where?: QueryNode | QueryWhereInput;
  order_by?: SortClause[];
  include?: IncludeClause[];
  limit?: number;
  skip?: number;
}

export interface QueryLike {
  toSpec(): QuerySpec;
}

/** Any query input accepted by collection query methods. */
export type QueryInput = QuerySpec | QueryLike | QueryWhereInput;

/** Array-like query result with convenience helpers. */
export interface QueryRows<T> extends Array<T> {
  /** Returns a plain array copy. */
  toArray(): T[];
  /** Returns a JSON-safe deep clone. */
  json(): T[];
  /** Returns the first row or `null`. */
  first(): T | null;
}

export interface TypegenOptions {
  moduleName?: string;
}

/** The query result envelope returned by the server. */
export interface QueryResult<T = VoidDocument> {
  results: T[];
  count: number;
}

// ── Engine Stats ──────────────────────────────────────────────────────────────

export interface EngineStats {
  memtable_size: number;
  memtable_count: number;
  segments: number;
  cache_len: number;
  cache_used: number;
  wal_seq: number;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export type UserRole = "admin" | "readwrite" | "readonly";

export interface VoidUser {
  id: string;
  role: UserRole;
  created_at: number;
  databases?: string[];
}

// ── Client config ─────────────────────────────────────────────────────────────

/** Configuration for the VoidDB client. */
export interface VoidClientConfig {
  /** Base URL of the VoidDB API server, e.g. "http://localhost:7700". */
  url: string;
  /** Pre-issued JWT access token. If omitted, call client.login() first. */
  token?: string;
  /** Request timeout in milliseconds (default 30 000). */
  timeout?: number;
}
