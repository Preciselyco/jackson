// SQL access for the Precisely directory-sync list API (DEV-1206).
//
// The views and indexes below read Jackson's generic key-value store (jackson_store /
// jackson_index, see npm/src/db/sql) directly, so lists can be filtered, sorted and paged
// in Postgres instead of loading whole directories through the store API. They are ours,
// not part of Jackson's TypeORM schema, and are created on first use by ensureSchema().
//
// Queries run on Jackson's own TypeORM DataSource (same pool, same DB_URL and TLS
// settings). It is reached through private fields of the directory-sync controller,
// like the OAuth code store in pages/api/precisely/sso/code/[code].ts: re-check
// dataSource() after every upstream sync.
import type { DataSource } from 'typeorm';
import type { SAMLJackson } from '@boxyhq/saml-jackson';
import { jacksonOptions } from '@lib/env';
import { logger } from '@lib/logger';

// Thrown when the configured store can't serve these routes. Handlers answer it as is.
export class StoreUnsupportedError extends Error {
  readonly statusCode = 501;
}

// The views parse each record once, in a LATERAL subquery (j.v): Postgres doesn't share
// common subexpressions, so every `s.value::jsonb` would parse the whole record, `raw`
// included, again. OFFSET 0 keeps the planner from inlining it back. Columns that an index
// serves (users' id and email_key, groups' id, memberships' group_id and user_id) are
// spelled `s.value::jsonb ->> …` instead, exactly like the index expressions, which is
// what lets the planner match them.
const parsed = `CROSS JOIN LATERAL (SELECT s.value::jsonb AS v OFFSET 0) j`;

// Normalises a JSON boolean that some IdPs send as a string ("true"/"false", any case).
// A missing or null value is `fallback`.
const jsonBool = (key: string, fallback: boolean) =>
  `CASE jsonb_typeof(j.v -> '${key}')
      WHEN 'boolean' THEN (j.v -> '${key}')::boolean
      WHEN 'string' THEN lower(btrim(j.v ->> '${key}')) = 'true'
      ELSE ${fallback} END`;

const text = (key: string) => `coalesce(j.v ->> '${key}', '')`;

// The namespace predicates must match the partial-index predicates below character for
// character, or the planner can't use the indexes. `iv IS NULL` keeps encrypted rows out
// of both: their value is ciphertext, and casting it to jsonb would fail.
const rows = (namespace: string, alias = '') =>
  `${alias}namespace LIKE 'dsync:${namespace}:%' AND ${alias}iv IS NULL`;
const usersRows = rows('users', 's.');
const groupsRows = rows('groups', 's.');
const membersRows = rows('members', 's.');

export const viewStatements = [
  `CREATE OR REPLACE VIEW precisely_dsync_directories AS
    SELECT s.key AS store_key,
      (j.v ->> 'id') AS id,
      ${text('name')} AS name,
      ${text('tenant')} AS tenant,
      ${text('product')} AS product,
      ${text('type')} AS type,
      ${jsonBool('deactivated', false)} AS deactivated,
      s."createdAt" AS created_at,
      s."modifiedAt" AS modified_at
    FROM jackson_store s ${parsed}
    WHERE s.namespace = 'dsync:config' AND s.iv IS NULL`,

  // A user whose JSON lacks `active` is active: that is Jackson's own default. email_key is
  // the trimmed, lower-cased email, spelled exactly like precisely_dsync_users_email_idx.
  `CREATE OR REPLACE VIEW precisely_dsync_users AS
    SELECT s.key AS store_key,
      s.namespace,
      (s.value::jsonb ->> 'id') AS id,
      ${text('email')} AS email,
      ${text('first_name')} AS first_name,
      ${text('last_name')} AS last_name,
      ${jsonBool('active', true)} AS active,
      s."createdAt" AS created_at,
      s."modifiedAt" AS modified_at,
      lower(btrim(s.value::jsonb ->> 'email')) AS email_key
    FROM jackson_store s ${parsed}
    WHERE ${usersRows}`,

  `CREATE OR REPLACE VIEW precisely_dsync_groups AS
    SELECT s.key AS store_key,
      s.namespace,
      (s.value::jsonb ->> 'id') AS id,
      ${text('name')} AS name,
      s."createdAt" AS created_at,
      s."modifiedAt" AS modified_at
    FROM jackson_store s ${parsed}
    WHERE ${groupsRows}`,

  // Membership records are small and both columns are index keys: no LATERAL here.
  `CREATE OR REPLACE VIEW precisely_dsync_memberships AS
    SELECT s.key AS store_key,
      s.namespace,
      (s.value::jsonb ->> 'group_id') AS group_id,
      (s.value::jsonb ->> 'user_id') AS user_id
    FROM jackson_store s
    WHERE ${membersRows}`,
];

// Every index has expression keys only, no plain column. TypeORM's schema sync (run on
// every boot, since manualMigration is off) loads a table's indexes by joining pg_index
// to pg_attribute on indkey, so a pure expression index is invisible to it and survives;
// an index with a plain key column would be dropped on the next boot as unknown.
export const indexes: { name: string; definition: string }[] = [
  {
    name: 'precisely_dsync_users_id_idx',
    definition: `jackson_store ((value::jsonb ->> 'id')) WHERE ${rows('users')}`,
  },
  {
    name: 'precisely_dsync_users_email_idx',
    definition: `jackson_store (lower(btrim(value::jsonb ->> 'email'))) WHERE ${rows('users')}`,
  },
  {
    name: 'precisely_dsync_groups_id_idx',
    definition: `jackson_store ((value::jsonb ->> 'id')) WHERE ${rows('groups')}`,
  },
  {
    name: 'precisely_dsync_members_group_id_idx',
    definition: `jackson_store ((value::jsonb ->> 'group_id')) WHERE ${rows('members')}`,
  },
  {
    name: 'precisely_dsync_members_user_id_idx',
    definition: `jackson_store ((value::jsonb ->> 'user_id')) WHERE ${rows('members')}`,
  },
];

// Serialise schema setup across Jackson pods. Separate keys, so a pod creating the views
// never waits for another pod's index build.
const viewsLockKey = 'precisely_dsync_views';
const indexesLockKey = 'precisely_dsync_indexes';

// The DataSource of Jackson's SQL driver: controller.users.db is the DB wrapper
// (npm/src/db/db.ts), its .db the Sql driver (npm/src/db/sql/sql.ts).
function dataSource(jackson: SAMLJackson): DataSource {
  const db = jacksonOptions.db;
  if ('driver' in db || db.engine !== 'sql' || db.type !== 'postgres') {
    throw new StoreUnsupportedError(
      'This endpoint needs the Postgres store (DB_ENGINE=sql, DB_TYPE=postgres)'
    );
  }
  if (db.encryptionKey) {
    throw new StoreUnsupportedError('This endpoint does not support an encrypted store (DB_ENCRYPTION_KEY)');
  }
  const ds = (jackson.directorySyncController.users as any)?.db?.db?.dataSource;
  if (!ds || typeof ds.query !== 'function' || typeof ds.createQueryRunner !== 'function') {
    throw new Error('Jackson SQL data source not found; check lib/precisely/db.ts after an upstream sync');
  }
  return ds as DataSource;
}

const g = global as any;

// Creates the views (awaited), then the indexes in the background: the queries work
// without them, only slower, and building them must never hold up a request. Runs once
// per process; a failure is retried on the next request.
async function ensureSchema(ds: DataSource): Promise<void> {
  if (!g.preciselyDsyncViews) {
    g.preciselyDsyncViews = withLock(ds, viewsLockKey, true, async (run) => {
      for (const stmt of viewStatements) {
        await run(stmt);
      }
    }).catch((err) => {
      g.preciselyDsyncViews = undefined;
      throw err;
    });
  }
  await g.preciselyDsyncViews;

  if (!g.preciselyDsyncIndexes) {
    // Another pod already building them is fine: skip, the indexes will be there.
    g.preciselyDsyncIndexes = withLock(ds, indexesLockKey, false, createIndexes).catch((err) => {
      logger.error(err, 'precisely: creating the dsync list indexes failed');
      g.preciselyDsyncIndexes = undefined;
    });
  }
}

// Runs fn on one connection holding a session advisory lock. With wait false, fn is
// skipped when another session holds the lock.
async function withLock(
  ds: DataSource,
  key: string,
  wait: boolean,
  fn: (run: (sql: string, params?: unknown[]) => Promise<any>) => Promise<void>
): Promise<void> {
  const qr = ds.createQueryRunner();
  await qr.connect();
  try {
    if (wait) {
      await qr.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    } else {
      const [{ locked }] = await qr.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
      if (!locked) return;
    }
    try {
      await fn((sql, params) => qr.query(sql, params));
    } finally {
      await qr.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    await qr.release();
  }
}

// CONCURRENTLY, so jackson_store is never locked against writes. A build that failed
// half-way leaves an INVALID index behind, which IF NOT EXISTS would skip: drop it first.
// Each statement runs on its own (CONCURRENTLY can't run in a transaction).
export async function createIndexes(run: (sql: string, params?: unknown[]) => Promise<any>) {
  for (const { name, definition } of indexes) {
    const invalid = await run(
      `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace AND NOT i.indisvalid`,
      [name]
    );
    if (invalid.length > 0) {
      await run(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    }
    await run(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${definition}`);
  }
}

export interface Sql {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

// A query function over Jackson's database with the views in place. When a view has gone
// missing since this process created it (dropped around an upstream schema change, see
// PRECISELY.md), the views are created again and the query retried once.
export async function preciselySql(jackson: SAMLJackson): Promise<Sql> {
  const ds = dataSource(jackson);
  await ensureSchema(ds);
  return {
    query: async (sql, params) => {
      try {
        return await ds.query(sql, params);
      } catch (err: any) {
        if (err?.code !== '42P01' || !/precisely_dsync_/.test(err?.message ?? '')) throw err;
        g.preciselyDsyncViews = undefined;
        g.preciselyDsyncIndexes = undefined;
        await ensureSchema(ds);
        return await ds.query(sql, params);
      }
    },
  };
}
