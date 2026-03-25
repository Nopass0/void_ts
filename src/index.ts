/**
 * @fileoverview VoidDB TypeScript ORM – public API surface.
 *
 * @example
 * import { VoidClient, query } from '@voiddb/orm'
 *
 * const client = new VoidClient({ url: 'http://localhost:7700', token: '...' })
 * const users = client.database('myapp').collection<User>('users')
 *
 * // Insert
 * const id = await users.insert({ name: 'Alice', age: 30 })
 *
 * // Query with builder
 * const result = await users.find(
 *   query().where('age', 'gte', 18).orderBy('name').limit(25)
 * )
 *
 * // Patch
 * await users.patch(id, { age: 31 })
 *
 * // Delete
 * await users.delete(id)
 */

export {
  VoidClient,
  Database,
  Collection,
  HttpClient,
  VoidError,
  SchemaManager,
} from "./client";
export { generateTypeDefinitions, modelSchemaLookup } from "./codegen";
export { parseSchemaFile, renderSchemaFile } from "./schemafile";
export { QueryBuilder, query } from "./query-builder";
export type {
  VoidClientConfig,
  VoidDocument,
  VoidValue,
  BlobRef,
  FilterOp,
  FilterClause,
  SortDir,
  SortClause,
  QuerySpec,
  QueryResult,
  EngineStats,
  TokenPair,
  UserRole,
  VoidUser,
  SchemaFieldType,
  SchemaRelation,
  SchemaIndex,
  SchemaField,
  CollectionSchema,
  SchemaDatasource,
  SchemaGenerator,
  SchemaModel,
  SchemaProject,
  SchemaOperationType,
  SchemaOperation,
  SchemaPlan,
  SchemaPushOptions,
  IncludeClause,
  TypegenOptions,
} from "./types";
