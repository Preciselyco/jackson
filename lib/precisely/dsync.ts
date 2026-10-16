// Directory-sync queries for the Precisely list API (DEV-1206), over the views in
// lib/precisely/db.ts.
//
// Jackson stores directory-sync records per tenant/product namespace
// (`dsync:users:<tenant>:<product>` …), and two directories may share one. A directory's
// users and groups are therefore found through Jackson's own `directoryId` secondary
// index in jackson_index, never through the namespace alone or the `directoryId` some
// user records carry. Group memberships are scoped through the directory's groups, and a
// membership counts only when its user is in the directory too.
//
// Everything here is plain parameterized SQL: the shared `dsync.users` / `dsync.groups`
// controllers and their setTenantAndProduct() are never touched, so concurrent requests
// for different directories can't race on their tenant.
import { keyDigest, keyForIndex } from '@boxyhq/saml-jackson/src/db/utils';
import { storeNamespacePrefix } from '@boxyhq/saml-jackson/src/controller/utils';
import { indexNames } from '@boxyhq/saml-jackson/src/directory-sync/scim/utils';
import type { Sql } from './db';
import { ListPage, ListRequest, ListSpec, Params } from './list';

export interface DirectoryRow {
  id: string;
  name: string;
  tenant: string;
  product: string;
  type: string;
  deactivated: boolean;
}

// The store keys and namespaces of one directory's records.
interface DirectoryKeys {
  usersNamespace: string;
  groupsNamespace: string;
  membersNamespace: string;
  // jackson_index keys of the directory's users and groups.
  usersIndex: string;
  groupsIndex: string;
}

// Mirrors how npm/src/db/store.ts and sql.ts build keys: the record key and index value
// are RIPEMD-160 digests, an index key is `<namespace>:<index name>:<digest>`.
function directoryKeys(dir: DirectoryRow): DirectoryKeys {
  const ns = (prefix: string) => `${prefix}:${dir.tenant}:${dir.product}`;
  const usersNamespace = ns(storeNamespacePrefix.dsync.users);
  const groupsNamespace = ns(storeNamespacePrefix.dsync.groups);
  const byDirectory = { name: indexNames.directoryId, value: keyDigest(dir.id) };
  return {
    usersNamespace,
    groupsNamespace,
    membersNamespace: ns(storeNamespacePrefix.dsync.members),
    usersIndex: keyForIndex(usersNamespace, byDirectory),
    groupsIndex: keyForIndex(groupsNamespace, byDirectory),
  };
}

export class DirectoryNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super('Directory not found');
  }
}

const directoryColumns = 'id, name, tenant, product, type, deactivated';

// The directory, or null when there is none with this ID.
export async function getDirectory(sql: Sql, id: string): Promise<DirectoryRow | null> {
  const storeKey = `${storeNamespacePrefix.dsync.config}:${keyDigest(id)}`;
  const rows = await sql.query<DirectoryRow>(
    `SELECT ${directoryColumns} FROM precisely_dsync_directories WHERE store_key = $1 AND id = $2`,
    [storeKey, id]
  );
  return rows[0] ?? null;
}

// SQL for the directory's users (du), groups (dg) and their memberships (dm). Its
// parameters are $1..$5 from directoryParams().
const directoryCTEs = `
  du AS (
    SELECT u.store_key, u.id, u.email, u.first_name, u.last_name, u.active
    FROM jackson_index i JOIN precisely_dsync_users u ON u.store_key = i."storeKey"
    WHERE i.key = $1 AND u.namespace = $2
  ),
  dg AS (
    SELECT g.store_key, g.id, g.name
    FROM jackson_index i JOIN precisely_dsync_groups g ON g.store_key = i."storeKey"
    WHERE i.key = $3 AND g.namespace = $4
  ),
  dm AS (
    SELECT DISTINCT m.group_id, m.user_id
    FROM precisely_dsync_memberships m
    WHERE m.namespace = $5 AND m.group_id IN (SELECT id FROM dg) AND m.user_id IN (SELECT id FROM du)
  )`;

function directoryParams(k: DirectoryKeys): unknown[] {
  return [k.usersIndex, k.usersNamespace, k.groupsIndex, k.groupsNamespace, k.membersNamespace];
}

// A user's groups in the directory, sorted by name, as [{id, name}]. userId is the SQL
// expression of the user's ID; the others are bound parameters as in directoryParams().
// Index-driven (members by user_id, then groups by id), for use per row of a page. The
// OFFSET 0 fence keeps that order: left to itself the planner would rather walk every
// group of the namespace and probe its members, which is ~50x slower per row.
const userGroupsSQL = (userId: string, groupsIndex: string, groupsNs: string, membersNs: string) => `
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name, g.id), '[]'::jsonb)
   FROM (SELECT DISTINCT g.id, g.name
         FROM (SELECT m.group_id FROM precisely_dsync_memberships m
               WHERE m.namespace = ${membersNs} AND m.user_id = ${userId} OFFSET 0) m
         JOIN precisely_dsync_groups g ON g.id = m.group_id AND g.namespace = ${groupsNs}
         WHERE EXISTS (SELECT 1 FROM jackson_index gi WHERE gi.key = ${groupsIndex} AND gi."storeKey" = g.store_key)
        ) g)`;

// How many members a group's `members` list shows; memberCount is always the full count.
export const groupMembersCap = 50;

export const userListSpec = new ListSpec({
  key: 'id',
  fields: [
    { name: 'id', type: 'text', column: 'x.id', attr: 'id' },
    { name: 'email', type: 'text', column: 'x.email', attr: 'email' },
    { name: 'firstName', type: 'text', column: 'x.first_name', attr: 'firstName' },
    { name: 'lastName', type: 'text', column: 'x.last_name', attr: 'lastName' },
    { name: 'active', type: 'boolean', column: 'x.active', attr: 'active' },
    { name: 'groupCount', type: 'number', integer: true, column: 'x.group_count', attr: 'groupCount' },
  ],
  search: ['x.id', 'x.email', 'x.first_name', 'x.last_name'],
  defaultSort: [{ field: 'email', desc: false }],
});

export const groupListSpec = new ListSpec({
  key: 'id',
  fields: [
    { name: 'id', type: 'text', column: 'x.id', attr: 'id' },
    { name: 'name', type: 'text', column: 'x.name', attr: 'name' },
    { name: 'memberCount', type: 'number', integer: true, column: 'x.member_count', attr: 'memberCount' },
  ],
  search: ['x.id', 'x.name'],
  defaultSort: [{ field: 'name', desc: false }],
});

export interface DirectoryUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
  groupCount: number;
  groups: { id: string; name: string }[];
}

export interface DirectoryGroup {
  id: string;
  name: string;
  memberCount: number;
  members: { id: string; email: string; firstName: string; lastName: string }[];
}

// Runs a list over `rows` (a CTE named x with the spec's columns): the total, then one
// page with `extras` (SQL select items over x) added to the page rows only.
async function runList<T extends Record<string, unknown>>(
  sql: Sql,
  spec: ListSpec,
  req: ListRequest,
  baseParams: unknown[],
  ctes: string,
  columns: string,
  extras: string,
  toItem: (row: any) => T
): Promise<ListPage<T>> {
  const params = new Params(baseParams);
  const plan = spec.plan(req, params);
  const where = plan.where.length > 0 ? `WHERE ${plan.where.join(' AND ')}` : '';

  // The count gets only the parameters it uses: Postgres refuses unused ones whose type
  // it can't infer.
  const countParams = params.values.slice(0, params.values.length - (plan.after ? plan.keys.length : 0));
  const [{ total }] = await sql.query<{ total: string }>(
    `WITH ${ctes} SELECT count(*) AS total FROM x ${where}`,
    countParams
  );

  const pageWhere = [...plan.where, ...(plan.after ? [plan.after] : [])];
  const rows = await sql.query(
    `WITH ${ctes}
     SELECT x.*, ${extras}
     FROM (SELECT ${columns} FROM x ${pageWhere.length > 0 ? `WHERE ${pageWhere.join(' AND ')}` : ''}
           ORDER BY ${plan.orderBy} LIMIT ${plan.limit + 1}) x
     ORDER BY ${plan.orderBy}`,
    params.values
  );
  return spec.page(plan, rows.map(toItem), Number(total));
}

export async function listUsers(
  sql: Sql,
  dir: DirectoryRow,
  req: ListRequest
): Promise<ListPage<DirectoryUser>> {
  const k = directoryKeys(dir);
  const ctes = `${directoryCTEs},
    x AS (
      SELECT du.id, du.email, du.first_name, du.last_name, du.active, coalesce(c.n, 0)::bigint AS group_count
      FROM du LEFT JOIN (SELECT user_id, count(*) AS n FROM dm GROUP BY user_id) c ON c.user_id = du.id
    )`;
  return runList(
    sql,
    userListSpec,
    req,
    directoryParams(k),
    ctes,
    'x.id, x.email, x.first_name, x.last_name, x.active, x.group_count',
    `${userGroupsSQL('x.id', '$3', '$4', '$5')} AS groups`,
    (r) => ({
      id: r.id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      active: r.active,
      groupCount: Number(r.group_count),
      groups: r.groups,
    })
  );
}

export async function listGroups(
  sql: Sql,
  dir: DirectoryRow,
  req: ListRequest
): Promise<ListPage<DirectoryGroup>> {
  const k = directoryKeys(dir);
  const ctes = `${directoryCTEs},
    x AS (
      SELECT dg.id, dg.name, coalesce(c.n, 0)::bigint AS member_count
      FROM dg LEFT JOIN (SELECT group_id, count(*) AS n FROM dm GROUP BY group_id) c ON c.group_id = dg.id
    )`;
  // The first members by email, from the directory's users and memberships the CTEs have
  // already materialised for member_count: each user record is parsed once per request,
  // where a per-group lookup would parse every member again for every group on the page.
  const members = `
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'firstName', u.first_name,
              'lastName', u.last_name) ORDER BY u.email, u.id), '[]'::jsonb)
     FROM (SELECT du.id, du.email, du.first_name, du.last_name
           FROM dm JOIN du ON du.id = dm.user_id
           WHERE dm.group_id = x.id
           ORDER BY du.email, du.id LIMIT ${groupMembersCap}) u) AS members`;
  return runList(
    sql,
    groupListSpec,
    req,
    directoryParams(k),
    ctes,
    'x.id, x.name, x.member_count',
    members,
    (r) => ({ id: r.id, name: r.name, memberCount: Number(r.member_count), members: r.members })
  );
}

export async function directorySummary(sql: Sql, dir: DirectoryRow) {
  const k = directoryKeys(dir);
  const [counts] = await sql.query<{ users: string; groups: string }>(
    `WITH ${directoryCTEs} SELECT (SELECT count(*) FROM du) AS users, (SELECT count(*) FROM dg) AS groups`,
    directoryParams(k)
  );
  return {
    id: dir.id,
    name: dir.name,
    tenant: dir.tenant,
    product: dir.product,
    type: dir.type,
    deactivated: dir.deactivated,
    userCount: Number(counts.users),
    groupCount: Number(counts.groups),
  };
}

export interface UserMatch {
  directory: { id: string; name: string; tenant: string; product: string; type: string };
  user: { id: string; email: string; firstName: string; lastName: string; active: boolean };
  groups: { id: string; name: string }[];
}

// Every directory user with this email (trimmed, case-insensitive), with their groups,
// sorted by directory name. directoryIds, when given, limits the directories searched.
export async function lookupUsersByEmail(
  sql: Sql,
  email: string,
  directoryIds?: string[]
): Promise<UserMatch[]> {
  const dirs = directoryIds
    ? await sql.query<DirectoryRow>(
        `SELECT ${directoryColumns} FROM precisely_dsync_directories WHERE id = ANY($1::text[])`,
        [directoryIds]
      )
    : await sql.query<DirectoryRow>(`SELECT ${directoryColumns} FROM precisely_dsync_directories`);
  if (dirs.length === 0) {
    return [];
  }
  const keys = dirs.map(directoryKeys);
  const rows = await sql.query(
    `SELECT d.ord, u.id, u.email, u.first_name, u.last_name, u.active,
       ${userGroupsSQL('u.id', 'd.groups_index', 'd.groups_ns', 'd.members_ns')} AS groups
     FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       AS d(ord, users_index, users_ns, groups_index, groups_ns, members_ns)
     JOIN precisely_dsync_users u ON u.namespace = d.users_ns
     WHERE u.email_key = lower(btrim($1))
       AND EXISTS (SELECT 1 FROM jackson_index ui WHERE ui.key = d.users_index AND ui."storeKey" = u.store_key)`,
    [
      email,
      dirs.map((_, i) => i),
      keys.map((k) => k.usersIndex),
      keys.map((k) => k.usersNamespace),
      keys.map((k) => k.groupsIndex),
      keys.map((k) => k.groupsNamespace),
      keys.map((k) => k.membersNamespace),
    ]
  );
  const matches: UserMatch[] = rows.map((r) => {
    const d = dirs[r.ord];
    return {
      directory: { id: d.id, name: d.name, tenant: d.tenant, product: d.product, type: d.type },
      user: { id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, active: r.active },
      groups: r.groups,
    };
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return matches.sort(
    (a, b) =>
      cmp(a.directory.name, b.directory.name) ||
      cmp(a.directory.id, b.directory.id) ||
      cmp(a.user.id, b.user.id)
  );
}
