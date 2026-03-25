/**
 * @fileoverview Fluent query builder for the VoidDB TypeScript ORM.
 *
 * @example
 * const q = new QueryBuilder()
 *   .where('age', 'gte', 18)
 *   .where('active', 'eq', true)
 *   .orderBy('name', 'asc')
 *   .limit(20)
 *   .skip(0)
 */

import type {
  FilterClause,
  FilterOp,
  IncludeClause,
  QueryNode,
  QuerySpec,
  SortClause,
  SortDir,
  VoidValue,
} from "./types";

/**
 * QueryBuilder provides a fluent, type-safe API for constructing VoidDB queries.
 * Every method returns a new immutable QueryBuilder instance.
 */
export class QueryBuilder {
  private readonly _filters: FilterClause[];
  private readonly _sorts: SortClause[];
  private readonly _includes: IncludeClause[];
  private readonly _limit: number | undefined;
  private readonly _skip: number | undefined;

  constructor(
    filters: FilterClause[] = [],
    sorts: SortClause[] = [],
    includes: IncludeClause[] = [],
    limit?: number,
    skip?: number
  ) {
    this._filters = filters;
    this._sorts = sorts;
    this._includes = includes;
    this._limit = limit;
    this._skip = skip;
  }

  /**
   * Adds a WHERE filter clause.
   *
   * @param field - The document field name to filter on.
   * @param op    - The comparison operator.
   * @param value - The value to compare against.
   */
  where(field: string, op: FilterOp, value: VoidValue): QueryBuilder {
    return new QueryBuilder(
      [...this._filters, { field, op, value }],
      this._sorts,
      this._includes,
      this._limit,
      this._skip
    );
  }

  /**
   * Adds an ORDER BY clause.
   *
   * @param field - The field to sort by.
   * @param dir   - Sort direction ("asc" or "desc"). Defaults to "asc".
   */
  orderBy(field: string, dir: SortDir = "asc"): QueryBuilder {
    return new QueryBuilder(
      this._filters,
      [...this._sorts, { field, dir }],
      this._includes,
      this._limit,
      this._skip
    );
  }

  /**
   * Adds an eager-loading include clause.
   */
  include(include: IncludeClause): QueryBuilder {
    return new QueryBuilder(
      this._filters,
      this._sorts,
      [...this._includes, include],
      this._limit,
      this._skip
    );
  }

  /**
   * Sets the maximum number of results to return.
   * @param n - Maximum result count.
   */
  limit(n: number): QueryBuilder {
    return new QueryBuilder(this._filters, this._sorts, this._includes, n, this._skip);
  }

  /**
   * Sets the number of results to skip (for pagination).
   * @param n - Number of results to skip.
   */
  skip(n: number): QueryBuilder {
    return new QueryBuilder(this._filters, this._sorts, this._includes, this._limit, n);
  }

  /**
   * Convenience: adds a page-based pagination.
   *
   * @param page     - 0-indexed page number.
   * @param pageSize - Number of items per page.
   */
  page(page: number, pageSize: number): QueryBuilder {
    return this.skip(page * pageSize).limit(pageSize);
  }

  /**
   * Serialises this builder into the QuerySpec JSON sent to the server.
   */
  toSpec(): QuerySpec {
    const spec: QuerySpec = {};
    if (this._filters.length === 1) {
      spec.where = this._filters[0];
    } else if (this._filters.length > 1) {
      spec.where = { AND: this._filters.map((filter): QueryNode => ({ ...filter })) };
    }
    if (this._sorts.length > 0) spec.order_by = this._sorts;
    if (this._includes.length > 0) spec.include = this._includes;
    if (this._limit !== undefined) spec.limit = this._limit;
    if (this._skip !== undefined) spec.skip = this._skip;
    return spec;
  }
}

/** Creates a new empty QueryBuilder. */
export function query(): QueryBuilder {
  return new QueryBuilder();
}
