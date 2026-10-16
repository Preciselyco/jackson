import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Directory } from '@boxyhq/saml-jackson';
import { createDirectory, deleteDirectory, directoryPayload } from '../api/helpers/directories';
import { createUser, deleteUser } from '../api/helpers/users';
import { createGroup } from '../api/helpers/groups';
import { scimOpUrl } from '../api/helpers/utils';

// The directory-sync list API for the backoffice (DEV-1206): POST .../users/list and
// .../groups/list under kvasir's v2 list contract, GET .../summary, and POST
// /api/precisely/dsync/users/lookup. They read Jackson's store through SQL views, which
// need an unencrypted Postgres store: against an encrypted one (upstream's CI env sets
// DB_ENCRYPTION_KEY) the routes answer 501, and only that is tested. The full suite runs
// in its own CI step against a server without DB_ENCRYPTION_KEY
// (e2e/precisely/playwright.config.ts).

const apiKey = (process.env.API_KEYS || process.env.JACKSON_API_KEYS || '').split(',')[0];
const headers = { Authorization: `Bearer ${apiKey}` };

// No admin session; the upstream helpers (directories) rely on the API key header.
test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: headers });

const run = `${Date.now()}`;
const tenant = `dsync-list-${run}`;
const product = 'dsync-list';

interface Seed {
  email: string;
  given?: string;
  family?: string;
  active?: unknown;
}

const user = ({ email, given, family, active }: Seed) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName: email,
  ...(given || family ? { name: { givenName: given, familyName: family } } : {}),
  emails: [{ primary: true, value: email, type: 'work' }],
  ...(active === undefined ? {} : { active }),
});

async function addMembers(request: APIRequestContext, dir: Directory, groupId: string, userIds: string[]) {
  const response = await request.patch(scimOpUrl(dir, `Groups/${groupId}`), {
    data: {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: userIds.map((value) => ({ value })) }],
    },
    headers: { Authorization: `Bearer ${dir.scim.secret}` },
  });
  expect(response.ok()).toBe(true);
}

async function list(request: APIRequestContext, path: string, body: unknown) {
  const response = await request.post(`/api/precisely/dsync/${path}`, { headers, data: body as any });
  return { status: response.status(), json: await response.json() };
}

async function ok(request: APIRequestContext, path: string, body: unknown = {}) {
  const { status, json } = await list(request, path, body);
  expect(status, JSON.stringify(json)).toBe(200);
  return json;
}

async function badRequest(request: APIRequestContext, path: string, body: unknown, message: RegExp) {
  const { status, json } = await list(request, path, body);
  expect(status, JSON.stringify(json)).toBe(400);
  expect(json.error.message).toMatch(message);
}

// Every page of a list, following nextCursor.
async function allPages(request: APIRequestContext, path: string, body: Record<string, unknown>) {
  const items: any[] = [];
  const totals = new Set<number>();
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await ok(request, path, { ...body, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    totals.add(page.total);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(totals.size).toBe(1);
  expect(items.length).toBe([...totals][0]);
  return items;
}

const emails = (items: any[]) => items.map((u) => u.email);

let storeSupported = true;
let dirA: Directory;
let dirB: Directory;
let dirC: Directory;
const ids: Record<string, string> = {};
const groupIds: Record<string, string> = {};

test.beforeAll(async ({ request }) => {
  const probe = await request.get('/api/precisely/dsync/no-such-directory/summary', { headers });
  storeSupported = probe.status() !== 501;
  if (!storeSupported) return;

  // Two directories on one tenant/product: namespace alone can't tell them apart.
  dirA = await createDirectory(request, { ...directoryPayload, tenant, product, name: `Alpha ${run}` });
  dirB = await createDirectory(request, { ...directoryPayload, tenant, product, name: `Beta ${run}` });
  dirC = await createDirectory(request, {
    ...directoryPayload,
    tenant: `${tenant}-c`,
    product,
    name: `Gamma ${run}`,
  });

  const seedA: Record<string, Seed> = {
    alice: { email: 'alice@example.com', given: 'Alice', family: 'Smith', active: true },
    bob: { email: 'bob@example.com', given: 'Bob', family: 'Smith', active: true },
    carol: { email: 'carol@example.com', given: 'Carol', family: 'Jones', active: false },
    // IdPs that send booleans as strings.
    dave: { email: 'dave@example.com', given: 'Dave', family: 'Smith', active: 'false' },
    erin: { email: 'erin@example.com', given: 'Erin', family: 'Jones', active: 'TRUE' },
    // No name at all: first and last name are ''.
    frank: { email: 'frank@example.com' },
    // LIKE wildcards in a value must match literally.
    gina: { email: 'gina@example.com', given: 'Gina', family: '50%_off' },
    shared: { email: 'Shared@Example.com', given: 'Shared', family: 'A' },
    gone: { email: 'gone@example.com', given: 'Gone', family: 'Soon' },
  };
  for (const [name, seed] of Object.entries(seedA)) {
    ids[name] = (await createUser(request, dirA, user(seed) as any)).id;
  }
  ids.sharedB = (
    await createUser(request, dirB, user({ email: 'shared@example.com', given: 'S', family: 'B' }) as any)
  ).id;
  ids.zed = (
    await createUser(request, dirB, user({ email: 'zed@example.com', given: 'Zed', family: 'B' }) as any)
  ).id;

  for (const name of ['Admins', 'Devs', 'Empty']) {
    groupIds[name] = (
      await createGroup(request, dirA, {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: name,
        members: [],
      })
    ).id;
  }
  groupIds.Bteam = (
    await createGroup(request, dirB, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Bteam',
      members: [],
    })
  ).id;
  await addMembers(request, dirA, groupIds.Admins, [ids.alice, ids.bob, ids.dave, ids.gone]);
  await addMembers(request, dirA, groupIds.Devs, [ids.alice, ids.carol, ids.shared]);
  await addMembers(request, dirB, groupIds.Bteam, [ids.zed, ids.sharedB]);
  // A membership whose user no longer exists counts nowhere.
  await deleteUser(request, dirA, ids.gone);

  // A group with more members than a list item shows.
  const big: string[] = [];
  for (let i = 0; i < 53; i++) {
    const n = String(i).padStart(2, '0');
    big.push(
      (
        await createUser(
          request,
          dirC,
          user({ email: `member${n}@example.com`, given: 'M', family: n }) as any
        )
      ).id
    );
  }
  groupIds.Big = (
    await createGroup(request, dirC, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Big',
      members: [],
    })
  ).id;
  await addMembers(request, dirC, groupIds.Big, big);
});

test.afterAll(async ({ request }) => {
  for (const dir of [dirA, dirB, dirC]) {
    if (dir) await deleteDirectory(request, dir.id);
  }
});

test.describe('encrypted store', () => {
  test('answers 501 with a clear message', async ({ request }) => {
    test.skip(storeSupported, 'the store is not encrypted');
    for (const response of [
      await request.get('/api/precisely/dsync/x/summary', { headers }),
      await request.post('/api/precisely/dsync/x/users/list', { headers, data: {} }),
      await request.post('/api/precisely/dsync/users/lookup', { headers, data: { email: 'a@b.c' } }),
    ]) {
      expect(response.status()).toBe(501);
      expect((await response.json()).error.message).toMatch(/encrypted store/);
    }
  });
});

test.describe('directory-sync list API', () => {
  test.beforeEach(() => {
    test.skip(!storeSupported, 'needs an unencrypted Postgres store');
  });

  test.describe('methods and unknown directories', () => {
    test('answer 404 for an unknown directory', async ({ request }) => {
      for (const path of ['users/list', 'groups/list']) {
        const { status, json } = await list(request, `no-such-directory/${path}`, {});
        expect(status).toBe(404);
        expect(json.error.message).toBe('Directory not found');
      }
      const summary = await request.get('/api/precisely/dsync/no-such-directory/summary', { headers });
      expect(summary.status()).toBe(404);
    });

    test('answer 405 for other methods', async ({ request }) => {
      const checks: [Promise<any>, string][] = [
        [request.get(`/api/precisely/dsync/${dirA.id}/users/list`, { headers }), 'POST'],
        [request.get(`/api/precisely/dsync/${dirA.id}/groups/list`, { headers }), 'POST'],
        [request.post(`/api/precisely/dsync/${dirA.id}/summary`, { headers }), 'GET'],
        [request.get('/api/precisely/dsync/users/lookup', { headers }), 'POST'],
      ];
      for (const [pending, allow] of checks) {
        const response = await pending;
        expect(response.status()).toBe(405);
        expect(response.headers()['allow']).toBe(allow);
      }
    });

    test('require the API key', async ({ request }) => {
      for (const path of [`${dirA.id}/users/list`, `${dirA.id}/groups/list`, 'users/lookup']) {
        const response = await request.post(`/api/precisely/dsync/${path}`, {
          headers: { Authorization: 'Bearer not-the-api-key' },
          data: {},
        });
        expect(response.status()).toBe(401);
      }
      const summary = await request.get(`/api/precisely/dsync/${dirA.id}/summary`, {
        headers: { Authorization: 'Bearer not-the-api-key' },
      });
      expect(summary.status()).toBe(401);
    });
  });

  test.describe('users/list', () => {
    const path = () => `${dirA.id}/users/list`;

    test('lists the directory users by email, with their groups', async ({ request }) => {
      const page = await ok(request, path());
      expect(page.total).toBe(8);
      expect(page.nextCursor).toBeNull();
      // Where the mixed-case email lands depends on the database collation.
      expect(emails(page.items).filter((e) => e !== 'Shared@Example.com')).toEqual([
        'alice@example.com',
        'bob@example.com',
        'carol@example.com',
        'dave@example.com',
        'erin@example.com',
        'frank@example.com',
        'gina@example.com',
      ]);
      const alice = page.items.find((u) => u.email === 'alice@example.com');
      expect(alice).toEqual({
        id: ids.alice,
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Smith',
        active: true,
        groupCount: 2,
        groups: [
          { id: groupIds.Admins, name: 'Admins' },
          { id: groupIds.Devs, name: 'Devs' },
        ],
      });
      const frank = page.items.find((u) => u.email === 'frank@example.com');
      expect(frank).toMatchObject({ firstName: '', lastName: '', active: true, groupCount: 0, groups: [] });
    });

    test('is scoped to the directory, not its tenant and product', async ({ request }) => {
      const a = await ok(request, path(), { limit: 200 });
      expect(emails(a.items)).not.toContain('zed@example.com');
      const b = await ok(request, `${dirB.id}/users/list`);
      expect(emails(b.items)).toEqual(['shared@example.com', 'zed@example.com']);
      expect(b.items[0].groups).toEqual([{ id: groupIds.Bteam, name: 'Bteam' }]);
    });

    test('normalises active sent as a string', async ({ request }) => {
      const inactive = await ok(request, path(), { filters: [{ field: 'active', op: 'eq', value: false }] });
      expect(emails(inactive.items)).toEqual(['carol@example.com', 'dave@example.com']);
      const active = await ok(request, path(), { filters: [{ field: 'active', op: 'eq', value: true }] });
      expect(emails(active.items)).toContain('erin@example.com');
      expect(active.total).toBe(6);
    });

    test('filters text fields with eq, in and contains', async ({ request }) => {
      const eq = await ok(request, path(), {
        filters: [{ field: 'email', op: 'eq', value: 'bob@example.com' }],
      });
      expect(eq.items.map((u) => u.id)).toEqual([ids.bob]);

      const inIds = await ok(request, path(), {
        filters: [{ field: 'id', op: 'in', value: [ids.carol, ids.zed] }],
      });
      expect(emails(inIds.items)).toEqual(['carol@example.com']);

      const contains = await ok(request, path(), {
        filters: [{ field: 'lastName', op: 'contains', value: 'SMI' }],
      });
      expect(contains.total).toBe(3);

      const firstName = await ok(request, path(), {
        filters: [{ field: 'firstName', op: 'in', value: ['Erin', 'Gina'] }],
      });
      expect(firstName.total).toBe(2);

      // % and _ match literally.
      const literal = await ok(request, path(), {
        filters: [{ field: 'lastName', op: 'contains', value: '%_' }],
      });
      expect(emails(literal.items)).toEqual(['gina@example.com']);
      const percent = await ok(request, path(), {
        filters: [{ field: 'lastName', op: 'contains', value: '%' }],
      });
      expect(percent.total).toBe(1);
    });

    test('filters groupCount with eq, in, gte, lte and between', async ({ request }) => {
      const count = async (op: string, value: unknown) =>
        (await ok(request, path(), { filters: [{ field: 'groupCount', op, value }] })).total;
      expect(await count('eq', 2)).toBe(1);
      expect(await count('in', [0])).toBe(3);
      expect(await count('gte', 1)).toBe(5);
      expect(await count('lte', 1)).toBe(7);
      expect(await count('between', [1, 2])).toBe(5);
      expect(await count('between', [2, 1])).toBe(0);
    });

    test('ANDs filters and the free-text query', async ({ request }) => {
      const both = await ok(request, path(), {
        query: '  smith ',
        filters: [{ field: 'active', op: 'eq', value: true }],
      });
      expect(emails(both.items)).toEqual(['alice@example.com', 'bob@example.com']);

      const byId = await ok(request, path(), { query: ids.erin });
      expect(emails(byId.items)).toEqual(['erin@example.com']);

      const byEmail = await ok(request, path(), { query: 'SHARED@' });
      expect(byEmail.total).toBe(1);
    });

    test('sorts by several keys, with the id as the final tie-breaker', async ({ request }) => {
      const page = await ok(request, path(), {
        sort: [
          { field: 'lastName', desc: true },
          { field: 'firstName', desc: false },
        ],
      });
      expect(page.items.map((u) => [u.lastName, u.firstName])).toEqual([
        ['Smith', 'Alice'],
        ['Smith', 'Bob'],
        ['Smith', 'Dave'],
        ['Jones', 'Carol'],
        ['Jones', 'Erin'],
        ['A', 'Shared'],
        ['50%_off', 'Gina'],
        ['', ''],
      ]);

      const byCount = await ok(request, path(), { sort: [{ field: 'groupCount', desc: true }] });
      expect(byCount.items.map((u) => u.groupCount)).toEqual([2, 1, 1, 1, 1, 0, 0, 0]);
      const zeros = byCount.items.filter((u) => u.groupCount === 0).map((u) => u.id);
      expect(zeros).toEqual([...zeros].sort());
    });

    test('pages through duplicates and empty values with the cursor', async ({ request }) => {
      for (const sort of [
        [{ field: 'lastName' }],
        [{ field: 'lastName', desc: true }],
        [{ field: 'groupCount', desc: true }, { field: 'active' }],
        [{ field: 'id', desc: true }],
      ]) {
        const whole = (await ok(request, path(), { sort, limit: 200 })).items.map((u) => u.id);
        for (const limit of [1, 2, 3]) {
          const paged = (await allPages(request, path(), { sort, limit })).map((u) => u.id);
          expect(paged, JSON.stringify({ sort, limit })).toEqual(whole);
        }
      }
    });

    test('keeps the total across pages and allows a changed limit', async ({ request }) => {
      const first = await ok(request, path(), { limit: 3, query: 'example' });
      expect(first.items).toHaveLength(3);
      expect(first.total).toBe(8);
      const second = await ok(request, path(), { limit: 4, query: 'example', cursor: first.nextCursor });
      expect(second.items).toHaveLength(4);
      expect(second.total).toBe(8);
      const whole = await ok(request, path(), { query: 'example' });
      expect([...first.items, ...second.items]).toEqual(whole.items.slice(0, 7));
    });

    test('rejects a cursor issued for another query, filter or sort', async ({ request }) => {
      const first = await ok(request, path(), { limit: 2, sort: [{ field: 'lastName' }] });
      const cursor = first.nextCursor;
      expect(cursor).toBeTruthy();
      const mismatch = /cursor does not match/;
      await badRequest(request, path(), { limit: 2, cursor }, mismatch);
      await badRequest(
        request,
        path(),
        { limit: 2, cursor, sort: [{ field: 'lastName', desc: true }] },
        mismatch
      );
      await badRequest(
        request,
        path(),
        { limit: 2, cursor, sort: [{ field: 'lastName' }], query: 'a' },
        mismatch
      );
      await badRequest(
        request,
        path(),
        {
          limit: 2,
          cursor,
          sort: [{ field: 'lastName' }],
          filters: [{ field: 'active', op: 'eq', value: true }],
        },
        mismatch
      );
      await badRequest(request, path(), { cursor: 'not a cursor' }, /invalid cursor/);
      // The groups list over the same directory doesn't take it either.
      await badRequest(request, `${dirA.id}/groups/list`, { cursor }, /cursor/);
    });

    test('rejects anything outside the allowlist', async ({ request }) => {
      const p = path();
      await badRequest(
        request,
        p,
        { filters: [{ field: 'raw', op: 'eq', value: 'x' }] },
        /field "raw" is not filterable/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'hasPreciselyUser', op: 'eq', value: true }] },
        /"hasPreciselyUser" is not filterable/
      );
      await badRequest(request, p, { sort: [{ field: 'raw' }] }, /field "raw" is not sortable/);
      await badRequest(
        request,
        p,
        { filters: [{ field: 'groupCount', op: 'contains', value: 1 }] },
        /operator "contains" is not allowed on number field "groupCount"/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'active', op: 'in', value: [true] }] },
        /operator "in" is not allowed on boolean/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'gte', value: 'a' }] },
        /operator "gte" is not allowed on text/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'like', value: 'a' }] },
        /unknown operator "like"/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'isNull', value: true }] },
        /never null/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'groupCount', op: 'eq', value: 1.5 }] },
        /must be an integer/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'groupCount', op: 'eq', value: '1' }] },
        /must be a number/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'eq', value: null }] },
        /must not be null; use isNull/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'active', op: 'eq', value: 'true' }] },
        /must be a boolean/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'in', value: [] }] },
        /between 1 and 100 values/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'in', value: Array(101).fill('a') }] },
        /between 1 and 100 values/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'groupCount', op: 'between', value: [1] }] },
        /two-element array/
      );
      await badRequest(
        request,
        p,
        { filters: [{ field: 'email', op: 'eq', value: 'a', extra: 1 }] },
        /unknown field "extra"/
      );
      await badRequest(
        request,
        p,
        { sort: [{ field: 'email' }, { field: 'email', desc: true }] },
        /more than once/
      );
      await badRequest(
        request,
        p,
        {
          sort: ['id', 'email', 'firstName', 'lastName', 'active', 'groupCount'].map((field) => ({ field })),
        },
        /at most 5 sort keys/
      );
      await badRequest(request, p, { limit: 201 }, /limit must be between 1 and 200/);
      await badRequest(request, p, { limit: -1 }, /limit must be between 1 and 200/);
      await badRequest(request, p, { page: 2 }, /unknown field "page"/);
      await badRequest(request, p, { query: null }, /query must not be null/);
      await badRequest(request, p, { filters: null }, /filters must not be null/);
      await badRequest(request, p, [], /not a JSON object/);

      // A null cursor is the first page.
      expect((await ok(request, p, { cursor: null })).total).toBe(8);
    });
  });

  test.describe('groups/list', () => {
    const path = () => `${dirA.id}/groups/list`;

    test('lists the directory groups by name, with their members', async ({ request }) => {
      const page = await ok(request, path());
      expect(page.total).toBe(3);
      expect(page.items).toEqual([
        {
          id: groupIds.Admins,
          name: 'Admins',
          memberCount: 3,
          members: [
            { id: ids.alice, email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith' },
            { id: ids.bob, email: 'bob@example.com', firstName: 'Bob', lastName: 'Smith' },
            { id: ids.dave, email: 'dave@example.com', firstName: 'Dave', lastName: 'Smith' },
          ],
        },
        expect.objectContaining({ id: groupIds.Devs, name: 'Devs', memberCount: 3 }),
        { id: groupIds.Empty, name: 'Empty', memberCount: 0, members: [] },
      ]);
    });

    test('is scoped to the directory', async ({ request }) => {
      const b = await ok(request, `${dirB.id}/groups/list`);
      expect(b.items.map((g) => g.name)).toEqual(['Bteam']);
      expect(b.items[0].members.map((m) => m.email)).toEqual(['shared@example.com', 'zed@example.com']);
    });

    test('caps members at 50 by email but counts them all', async ({ request }) => {
      const page = await ok(request, `${dirC.id}/groups/list`);
      const big = page.items[0];
      expect(big.memberCount).toBe(53);
      expect(big.members).toHaveLength(50);
      expect(big.members[0].email).toBe('member00@example.com');
      expect(big.members[49].email).toBe('member49@example.com');
    });

    test('filters, searches and sorts', async ({ request }) => {
      const p = path();
      const names = (r: any) => r.items.map((g) => g.name);
      expect(
        names(await ok(request, p, { filters: [{ field: 'memberCount', op: 'gte', value: 1 }] }))
      ).toEqual(['Admins', 'Devs']);
      expect(
        names(await ok(request, p, { filters: [{ field: 'memberCount', op: 'eq', value: 0 }] }))
      ).toEqual(['Empty']);
      expect(
        names(await ok(request, p, { filters: [{ field: 'memberCount', op: 'between', value: [0, 2] }] }))
      ).toEqual(['Empty']);
      expect(
        names(await ok(request, p, { filters: [{ field: 'memberCount', op: 'lte', value: 3 }] }))
      ).toHaveLength(3);
      expect(
        names(await ok(request, p, { filters: [{ field: 'memberCount', op: 'in', value: [3] }] }))
      ).toEqual(['Admins', 'Devs']);
      expect(
        names(await ok(request, p, { filters: [{ field: 'name', op: 'contains', value: 'DEV' }] }))
      ).toEqual(['Devs']);
      expect(names(await ok(request, p, { filters: [{ field: 'name', op: 'eq', value: 'Empty' }] }))).toEqual(
        ['Empty']
      );
      expect(
        names(await ok(request, p, { filters: [{ field: 'name', op: 'in', value: ['Empty', 'Devs'] }] }))
      ).toEqual(['Devs', 'Empty']);
      expect(
        names(await ok(request, p, { filters: [{ field: 'id', op: 'eq', value: groupIds.Admins }] }))
      ).toEqual(['Admins']);
      expect(names(await ok(request, p, { query: 'adm' }))).toEqual(['Admins']);
      expect(names(await ok(request, p, { query: groupIds.Devs }))).toEqual(['Devs']);
      expect(names(await ok(request, p, { sort: [{ field: 'name', desc: true }] }))).toEqual([
        'Empty',
        'Devs',
        'Admins',
      ]);

      const byCount = await ok(request, p, { sort: [{ field: 'memberCount', desc: true }] });
      expect(byCount.items.map((g) => g.memberCount)).toEqual([3, 3, 0]);
      expect(byCount.items.slice(0, 2).map((g) => g.id)).toEqual([groupIds.Admins, groupIds.Devs].sort());

      const paged = (await allPages(request, p, { sort: [{ field: 'memberCount' }], limit: 1 })).map(
        (g) => g.id
      );
      expect(paged).toEqual(
        (await ok(request, p, { sort: [{ field: 'memberCount' }] })).items.map((g) => g.id)
      );

      await badRequest(
        request,
        p,
        { filters: [{ field: 'members', op: 'eq', value: 'x' }] },
        /not filterable/
      );
      await badRequest(request, p, { sort: [{ field: 'email' }] }, /not sortable/);
    });
  });

  test.describe('summary', () => {
    test('returns the directory with its counts', async ({ request }) => {
      const response = await request.get(`/api/precisely/dsync/${dirA.id}/summary`, { headers });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({
        id: dirA.id,
        name: `Alpha ${run}`,
        tenant,
        product,
        type: 'okta-scim-v2',
        deactivated: false,
        userCount: 8,
        groupCount: 3,
      });
      const b = await (await request.get(`/api/precisely/dsync/${dirB.id}/summary`, { headers })).json();
      expect(b).toMatchObject({ userCount: 2, groupCount: 1 });
    });
  });

  test.describe('users/lookup', () => {
    const lookup = (request: APIRequestContext, body: unknown) => list(request, 'users/lookup', body);

    test('finds a user in every directory by trimmed, case-insensitive email', async ({ request }) => {
      const { status, json } = await lookup(request, { email: '  SHARED@example.COM ' });
      expect(status).toBe(200);
      expect(json.matches).toEqual([
        {
          directory: { id: dirA.id, name: `Alpha ${run}`, tenant, product, type: 'okta-scim-v2' },
          user: {
            id: ids.shared,
            email: 'Shared@Example.com',
            firstName: 'Shared',
            lastName: 'A',
            active: true,
          },
          groups: [{ id: groupIds.Devs, name: 'Devs' }],
        },
        {
          directory: { id: dirB.id, name: `Beta ${run}`, tenant, product, type: 'okta-scim-v2' },
          user: { id: ids.sharedB, email: 'shared@example.com', firstName: 'S', lastName: 'B', active: true },
          groups: [{ id: groupIds.Bteam, name: 'Bteam' }],
        },
      ]);
    });

    test('limits the search to directoryIds', async ({ request }) => {
      const { json } = await lookup(request, {
        email: 'shared@example.com',
        directoryIds: [dirB.id, 'unknown'],
      });
      expect(json.matches.map((m) => m.directory.id)).toEqual([dirB.id]);
      const none = await lookup(request, { email: 'shared@example.com', directoryIds: [] });
      expect(none.json.matches).toEqual([]);
      const unknown = await lookup(request, { email: 'nobody@example.com' });
      expect(unknown.json.matches).toEqual([]);
    });

    test('rejects a malformed request', async ({ request }) => {
      for (const [body, message] of [
        [{}, /email must be a non-empty string/],
        [{ email: '  ' }, /email must be a non-empty string/],
        [{ email: 1 }, /email must be a non-empty string/],
        [{ email: 'a@b.c', directoryIds: 'x' }, /directoryIds must be an array of strings/],
        [{ email: 'a@b.c', directoryIds: Array(101).fill('x') }, /at most 100/],
        [{ email: 'a@b.c', directoryIds: null }, /must not be null/],
        [{ email: 'a@b.c', tenant: 'x' }, /unknown field "tenant"/],
      ] as [unknown, RegExp][]) {
        const { status, json } = await lookup(request, body);
        expect(status, JSON.stringify(body)).toBe(400);
        expect(json.error.message).toMatch(message);
      }
    });
  });
});
