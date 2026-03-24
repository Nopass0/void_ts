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
}

/** A raw document as returned by the API (always includes _id). */
export interface VoidDocument {
  _id: string;
  [field: string]: VoidValue;
}

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

/** A sort specification. */
export interface SortClause {
  field: string;
  dir: SortDir;
}

/** The complete query specification sent to the server. */
export interface QuerySpec {
  where?: FilterClause[];
  order_by?: SortClause[];
  limit?: number;
  skip?: number;
}

/** The query result envelope returned by the server. */
export interface QueryResult<T extends VoidDocument = VoidDocument> {
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
