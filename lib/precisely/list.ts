// The backoffice v2 list contract (DEV-1206), ported from kvasir's
// controllers/backoffice/listing/listing.go so kvasir can forward list requests to
// Jackson unchanged: a free-text query, typed filters, multi-key sort, keyset cursor
// paging and a total count, compiled to parameterized Postgres SQL.
//
// Every list declares a ListSpec: the fields a client may filter and sort on, each with a
// type that fixes the allowed operators and the SQL expression it maps to. Anything not
// declared is a ListRequestError, which handlers answer with a 400.
//
// The primary key is always appended as the final sort key so the order is total. The
// cursor carries the last row's sort-key values and a fingerprint of the query, filters
// and effective sort it was issued for, so it can't be replayed against another listing.
// Every field here is non-nullable (the views coalesce missing values), so isNull is never
// allowed and NULL ordering never comes into play.
import { createHash } from 'crypto';

export type FieldType = 'text' | 'number' | 'boolean';
export type Op = 'eq' | 'in' | 'contains' | 'gte' | 'lte' | 'between' | 'isNull';

const allOps: Op[] = ['eq', 'in', 'contains', 'gte', 'lte', 'between', 'isNull'];

const opsByType: Record<FieldType, Op[]> = {
  text: ['eq', 'in', 'contains'],
  number: ['eq', 'in', 'gte', 'lte', 'between'],
  boolean: ['eq'],
};

export const defaultLimit = 50;
export const maxLimit = 200;
export const maxInValues = 100;
export const maxSortKeys = 5;

export interface ListField {
  // Name on the wire.
  name: string;
  type: FieldType;
  // SQL expression the field filters and sorts on.
  column: string;
  // Key of the row object that holds this field's value; the cursor is built from it.
  attr: string;
  // Number fields: integral values only, bound as bigint. Every number field here is.
  integer?: boolean;
}

export interface Sort {
  field: string;
  desc: boolean;
}

export interface Filter {
  field: string;
  op: Op;
  value: unknown;
}

export interface ListRequest {
  query: string;
  filters: Filter[];
  sort: Sort[];
  limit: number;
  cursor: string | null;
}

export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

// Anything wrong with the request itself. Handlers answer it with a 400.
export class ListRequestError extends Error {
  readonly statusCode = 400;
}

export function fail(message: string): never {
  throw new ListRequestError(message);
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Checks that obj has no keys besides allowed, as Go's DisallowUnknownFields does.
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      fail(`invalid request body: unknown field "${k}" in ${what}`);
    }
  }
}

// A request body as JSON. Next has already decoded it when it came as application/json;
// any other content type arrives as a string. An empty body is undefined.
export function jsonBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body;
  }
  if (body.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return fail('invalid request body: not JSON');
  }
}

// Parses a list request body (see jsonBody). An empty body is the default request.
// Unknown keys are rejected, and so is null anywhere but as the cursor.
export function parseListRequest(rawBody: unknown): ListRequest {
  const req: ListRequest = { query: '', filters: [], sort: [], limit: 0, cursor: null };
  const body = jsonBody(rawBody);
  if (body === undefined) {
    return req;
  }
  if (!isObject(body)) {
    fail('invalid request body: not a JSON object');
  }
  const obj = body as Record<string, unknown>;
  rejectUnknownKeys(obj, ['query', 'filters', 'sort', 'limit', 'cursor'], 'request');
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'cursor' && v === null) {
      fail(`invalid request body: ${k} must not be null`);
    }
  }

  if ('query' in obj) {
    if (typeof obj.query !== 'string') fail('invalid request body: query must be a string');
    req.query = obj.query as string;
  }
  if ('limit' in obj) {
    if (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit)) {
      fail('invalid request body: limit must be an integer');
    }
    req.limit = obj.limit as number;
  }
  if ('cursor' in obj && obj.cursor !== null) {
    if (typeof obj.cursor !== 'string') fail('invalid request body: cursor must be a string');
    req.cursor = obj.cursor as string;
  }
  if ('filters' in obj) {
    if (!Array.isArray(obj.filters)) fail('invalid request body: filters must be an array');
    req.filters = (obj.filters as unknown[]).map((f) => {
      if (!isObject(f)) fail('invalid request body: each filter must be an object');
      const fo = f as Record<string, unknown>;
      rejectUnknownKeys(fo, ['field', 'op', 'value'], 'filter');
      if (fo.field !== undefined && fo.field !== null && typeof fo.field !== 'string') {
        fail('invalid request body: filter field must be a string');
      }
      if (fo.op !== undefined && fo.op !== null && typeof fo.op !== 'string') {
        fail('invalid request body: filter op must be a string');
      }
      return { field: (fo.field as string) ?? '', op: ((fo.op as string) ?? '') as Op, value: fo.value };
    });
  }
  if ('sort' in obj) {
    if (!Array.isArray(obj.sort)) fail('invalid request body: sort must be an array');
    req.sort = (obj.sort as unknown[]).map((s) => {
      if (!isObject(s)) fail('invalid request body: each sort key must be an object');
      const so = s as Record<string, unknown>;
      rejectUnknownKeys(so, ['field', 'desc'], 'sort');
      if (so.field !== undefined && so.field !== null && typeof so.field !== 'string') {
        fail('invalid request body: sort field must be a string');
      }
      if (so.desc !== undefined && so.desc !== null && typeof so.desc !== 'boolean') {
        fail('invalid request body: sort desc must be a boolean');
      }
      return { field: (so.field as string) ?? '', desc: so.desc === true };
    });
  }
  return req;
}

// Collects bound parameters for one SQL statement as $1, $2, ...
export class Params {
  readonly values: unknown[] = [];

  constructor(initial: unknown[] = []) {
    this.values.push(...initial);
  }

  add(v: unknown, cast?: string): string {
    this.values.push(v);
    return `$${this.values.length}${cast ? '::' + cast : ''}`;
  }
}

export interface ListSpecOptions {
  fields: ListField[];
  // The primary key: a non-null, unique text field. Always the last sort key.
  key: string;
  // SQL columns matched by the free-text query (case-insensitive substring).
  search: string[];
  defaultSort: Sort[];
}

interface SortKey {
  field: ListField;
  desc: boolean;
}

// A validated request, compiled to SQL fragments over the spec's columns.
export interface ListPlan {
  // Conditions from the query and filters, ANDed; empty when there are none.
  where: string[];
  // Keyset condition for rows after the cursor; null on the first page.
  after: string | null;
  orderBy: string;
  limit: number;
  keys: SortKey[];
  fingerprint: string;
}

export class ListSpec {
  private readonly fields = new Map<string, ListField>();
  private readonly key: ListField;

  constructor(private readonly opts: ListSpecOptions) {
    for (const f of opts.fields) {
      if (this.fields.has(f.name)) throw new Error(`list spec: duplicate field ${f.name}`);
      this.fields.set(f.name, f);
    }
    const key = this.fields.get(opts.key);
    if (!key || key.type !== 'text') throw new Error('list spec: key must be a declared text field');
    this.key = key;
  }

  get fieldNames(): string[] {
    return [...this.fields.keys()];
  }

  // Validates req and compiles it. Parameters are added to params in order.
  plan(req: ListRequest, params: Params): ListPlan {
    let limit = req.limit;
    if (limit === 0) {
      limit = defaultLimit;
    } else if (limit < 0 || limit > maxLimit) {
      fail(`limit must be between 1 and ${maxLimit}`);
    }

    const where = req.filters.map((f) => this.filter(f, params));

    const query = req.query.trim();
    if (query !== '') {
      const pattern = params.add(`%${escapeLike(query)}%`);
      where.push(`(${this.opts.search.map((c) => `${c} ILIKE ${pattern}`).join(' OR ')})`);
    }

    const sorts = req.sort.length > 0 ? req.sort : this.opts.defaultSort;
    if (sorts.length > maxSortKeys) {
      fail(`at most ${maxSortKeys} sort keys are allowed`);
    }
    const keys: SortKey[] = [];
    const seen = new Set<string>();
    for (const s of sorts) {
      const field = this.fields.get(s.field);
      if (!field) fail(`field "${s.field}" is not sortable`);
      if (seen.has(s.field)) fail(`field "${s.field}" appears more than once in sort`);
      seen.add(s.field);
      keys.push({ field: field!, desc: s.desc });
    }
    if (!seen.has(this.key.name)) {
      keys.push({ field: this.key, desc: false });
    }

    const fp = fingerprint(query, req.filters, keys);
    let after: string | null = null;
    if (req.cursor !== null) {
      const values = decodeCursor(req.cursor, fp, keys);
      after = afterCondition(keys, values, params);
    }

    const orderBy = keys.map((k) => `${k.field.column} ${k.desc ? 'DESC' : 'ASC'} NULLS LAST`).join(', ');
    return { where, after, orderBy, limit, keys, fingerprint: fp };
  }

  // Builds the page from the rows fetched with LIMIT plan.limit + 1.
  page<T extends Record<string, unknown>>(plan: ListPlan, rows: T[], total: number): ListPage<T> {
    if (rows.length <= plan.limit) {
      return { items: rows, nextCursor: null, total };
    }
    const items = rows.slice(0, plan.limit);
    return { items, nextCursor: encodeCursor(plan, items[items.length - 1]), total };
  }

  private filter(f: Filter, params: Params): string {
    const field = this.fields.get(f.field);
    if (!field) fail(`field "${f.field}" is not filterable`);
    const fld = field!;
    if (f.op === 'isNull') {
      fail(`field "${f.field}" is never null; isNull is not allowed`);
    }
    if (!opsByType[fld.type].includes(f.op)) {
      if (!allOps.includes(f.op)) fail(`unknown operator "${f.op}"`);
      fail(`operator "${f.op}" is not allowed on ${fld.type} field "${f.field}"`);
    }
    const col = fld.column;
    switch (f.op) {
      case 'eq':
        return `${col} = ${bind(fld, parseScalar(fld, f.value), params)}`;
      case 'in': {
        if (!Array.isArray(f.value)) fail(`in on "${f.field}" needs an array value`);
        const vals = f.value as unknown[];
        if (vals.length === 0 || vals.length > maxInValues) {
          fail(`in on "${f.field}" needs between 1 and ${maxInValues} values`);
        }
        const parsed = vals.map((v) => parseScalar(fld, v));
        return `${col} = ANY(${params.add(parsed, arrayType(fld))})`;
      }
      case 'contains': {
        const v = parseScalar(fld, f.value) as string;
        return `${col} ILIKE ${params.add(`%${escapeLike(v)}%`)}`;
      }
      case 'gte':
        return `${col} >= ${bind(fld, parseScalar(fld, f.value), params)}`;
      case 'lte':
        return `${col} <= ${bind(fld, parseScalar(fld, f.value), params)}`;
      case 'between': {
        if (!Array.isArray(f.value) || f.value.length !== 2) {
          fail(`between on "${f.field}" needs a two-element array value`);
        }
        const [lo, hi] = (f.value as unknown[]).map((v) => parseScalar(fld, v));
        return `(${col} >= ${bind(fld, lo, params)} AND ${col} <= ${bind(fld, hi, params)})`;
      }
    }
    return fail(`unknown operator "${f.op}"`);
  }
}

function scalarType(f: ListField): string {
  switch (f.type) {
    case 'number':
      return f.integer ? 'bigint' : 'numeric';
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
}

const arrayType = (f: ListField) => `${scalarType(f)}[]`;

function bind(f: ListField, v: unknown, params: Params): string {
  // Bound as text and cast in SQL, so a bigint never passes through a JS number twice.
  return params.add(f.type === 'text' ? v : String(v), scalarType(f));
}

function parseScalar(f: ListField, v: unknown): string | number | boolean {
  if (v === null || v === undefined) {
    fail(`value for "${f.name}" must not be null; use isNull`);
  }
  switch (f.type) {
    case 'text':
      if (typeof v !== 'string') fail(`value for "${f.name}" must be a string`);
      return v as string;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`value for "${f.name}" must be a number`);
      if (f.integer && !Number.isSafeInteger(v)) fail(`value for "${f.name}" must be an integer`);
      return v as number;
    case 'boolean':
      if (typeof v !== 'boolean') fail(`value for "${f.name}" must be a boolean`);
      return v as boolean;
  }
}

// Escapes the LIKE wildcards in s so it matches literally (backslash is Postgres's default
// LIKE escape character).
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// Rows strictly after the cursor position: for some i, every earlier key equals the
// cursor's value and key i is past it.
function afterCondition(keys: SortKey[], values: unknown[], params: Params): string {
  const bound = keys.map((k, i) => bind(k.field, values[i], params));
  const ors = keys.map((k, i) => {
    const conds = keys.slice(0, i).map((kj, j) => `${kj.field.column} = ${bound[j]}`);
    conds.push(`${k.field.column} ${k.desc ? '<' : '>'} ${bound[i]}`);
    return `(${conds.join(' AND ')})`;
  });
  return `(${ors.join(' OR ')})`;
}

// A JSON encoding with object keys sorted, so equal values fingerprint equally.
function canonicalJSON(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function fingerprint(query: string, filters: Filter[], keys: SortKey[]): string {
  const payload = canonicalJSON({
    q: query,
    f: filters.map((f) => ({ field: f.field, op: f.op, value: f.value ?? null })),
    s: keys.map((k) => ({ field: k.field.name, desc: k.desc })),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function encodeCursor(plan: ListPlan, last: Record<string, unknown>): string {
  const payload = { f: plan.fingerprint, v: plan.keys.map((k) => last[k.field.attr]) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor: string, fp: string, keys: SortKey[]): unknown[] {
  let payload: unknown;
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(cursor)) throw new Error();
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return fail('invalid cursor');
  }
  if (!isObject(payload) || typeof payload.f !== 'string' || !Array.isArray(payload.v)) {
    return fail('invalid cursor');
  }
  if (payload.f !== fp) {
    fail('cursor does not match the query, filters and sort of this request');
  }
  const values = payload.v as unknown[];
  if (values.length !== keys.length) fail('invalid cursor');
  // The cursor isn't signed, so each value is checked against its field's type: a forged
  // value of the wrong type would otherwise fail in Postgres with a 500.
  return values.map((v, i) => {
    const f = keys[i].field;
    const ok =
      (f.type === 'text' && typeof v === 'string') ||
      (f.type === 'boolean' && typeof v === 'boolean') ||
      (f.type === 'number' &&
        typeof v === 'number' &&
        (f.integer ? Number.isSafeInteger(v) : Number.isFinite(v)));
    if (!ok) fail('invalid cursor');
    return v;
  });
}
