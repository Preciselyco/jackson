import { test, expect } from '@playwright/test';
import {
  ListRequestError,
  ListSpec,
  Params,
  escapeLike,
  jsonBody,
  parseListRequest,
} from '@lib/precisely/list';

// Pure logic of the backoffice v2 list contract in lib/precisely/list.ts (DEV-1206). The
// routes that use it are tested end to end in dsync-list.spec.ts. Needs no server.

const spec = new ListSpec({
  key: 'id',
  fields: [
    { name: 'id', type: 'text', column: 'x.id', attr: 'id' },
    { name: 'name', type: 'text', column: 'x.name', attr: 'name' },
    { name: 'count', type: 'number', integer: true, column: 'x.count', attr: 'count' },
    { name: 'on', type: 'boolean', column: 'x.on', attr: 'on' },
  ],
  search: ['x.id', 'x.name'],
  defaultSort: [{ field: 'name', desc: false }],
});

const plan = (body: unknown) => {
  const params = new Params(['base']);
  return { plan: spec.plan(parseListRequest(body), params), params: params.values };
};

const rejects = (body: unknown, message: RegExp) => {
  expect(() => plan(body)).toThrow(ListRequestError);
  expect(() => plan(body)).toThrow(message);
};

// The cursor a page ending in `last` hands out.
const cursorAfter = (body: Record<string, unknown>, last: Record<string, unknown>) => {
  const { plan: p } = plan(body);
  const rows = Array.from({ length: p.limit + 1 }, () => last);
  return spec.page(p, rows, 0).nextCursor!;
};

test.describe('list request parsing', () => {
  test('treats an empty body as the default request', () => {
    for (const body of [undefined, '', '  ', {}]) {
      expect(parseListRequest(body)).toEqual({ query: '', filters: [], sort: [], limit: 0, cursor: null });
    }
  });

  test('reads a JSON body sent as text', () => {
    expect(jsonBody('{"query":"a"}')).toEqual({ query: 'a' });
    expect(() => jsonBody('{')).toThrow(/not JSON/);
  });

  test('rejects unknown keys and nulls, except a null cursor', () => {
    expect(parseListRequest({ cursor: null }).cursor).toBeNull();
    for (const [body, message] of [
      [{ offset: 1 }, /unknown field "offset"/],
      [{ filters: [{ field: 'a', op: 'eq', value: 1, x: 1 }] }, /unknown field "x" in filter/],
      [{ sort: [{ field: 'a', asc: true }] }, /unknown field "asc" in sort/],
      [{ limit: null }, /limit must not be null/],
      [{ sort: null }, /sort must not be null/],
      [{ limit: 1.5 }, /limit must be an integer/],
      [{ query: 1 }, /query must be a string/],
      [{ cursor: 1 }, /cursor must be a string/],
      [{ filters: {} }, /filters must be an array/],
      [{ sort: [{ field: 'a', desc: 'yes' }] }, /desc must be a boolean/],
      [null, /not a JSON object/],
      ['[1]', /not a JSON object/],
    ] as [unknown, RegExp][]) {
      expect(() => parseListRequest(body), JSON.stringify(body)).toThrow(message);
    }
  });
});

test.describe('list plans', () => {
  test('bind every value as a parameter, never into the SQL', () => {
    const { plan: p, params } = plan({
      query: "o'brien",
      filters: [
        { field: 'name', op: 'eq', value: "'; drop table x; --" },
        { field: 'count', op: 'in', value: [1, 2] },
        { field: 'on', op: 'eq', value: true },
      ],
    });
    expect(p.where).toEqual([
      'x.name = $2::text',
      'x.count = ANY($3::bigint[])',
      'x.on = $4::boolean',
      '(x.id ILIKE $5 OR x.name ILIKE $5)',
    ]);
    expect(params).toEqual(['base', "'; drop table x; --", [1, 2], 'true', "%o'brien%"]);
  });

  test('append the key to the sort, ascending, unless it is already there', () => {
    expect(plan({}).plan.orderBy).toBe('x.name ASC NULLS LAST, x.id ASC NULLS LAST');
    expect(plan({ sort: [{ field: 'count', desc: true }] }).plan.orderBy).toBe(
      'x.count DESC NULLS LAST, x.id ASC NULLS LAST'
    );
    expect(plan({ sort: [{ field: 'id', desc: true }, { field: 'name' }] }).plan.orderBy).toBe(
      'x.id DESC NULLS LAST, x.name ASC NULLS LAST'
    );
  });

  test('apply the limit rules', () => {
    expect(plan({}).plan.limit).toBe(50);
    expect(plan({ limit: 200 }).plan.limit).toBe(200);
    rejects({ limit: 201 }, /between 1 and 200/);
    rejects({ limit: -5 }, /between 1 and 200/);
  });

  test('escape LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    const { params } = plan({ filters: [{ field: 'name', op: 'contains', value: '%_' }] });
    expect(params[1]).toBe('%\\%\\_%');
  });

  test('build the keyset condition from the cursor', () => {
    const body = { sort: [{ field: 'count', desc: true }, { field: 'name' }] };
    const cursor = cursorAfter(body, { id: 'k', name: 'n', count: 3 });
    const { plan: p, params } = plan({ ...body, cursor });
    expect(p.after).toBe(
      '((x.count < $2::bigint) OR (x.count = $2::bigint AND x.name > $3::text) OR ' +
        '(x.count = $2::bigint AND x.name = $3::text AND x.id > $4::text))'
    );
    expect(params).toEqual(['base', '3', 'n', 'k']);
  });

  test('hand out no cursor on the last page', () => {
    const { plan: p } = plan({ limit: 2 });
    expect(spec.page(p, [{ id: 'a' }, { id: 'b' }], 2)).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      nextCursor: null,
      total: 2,
    });
    expect(spec.page(p, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 3).items).toHaveLength(2);
  });

  test('fingerprint the query, filters and effective sort, not the limit', () => {
    const body = {
      query: 'a',
      filters: [{ field: 'name', op: 'eq', value: 'x' }],
      sort: [{ field: 'name' }],
    };
    const cursor = cursorAfter(body, { id: 'k', name: 'n' });
    expect(() => plan({ ...body, cursor, limit: 7 })).not.toThrow();
    // The default sort is the effective sort when none is given.
    expect(() => plan({ query: 'a', filters: body.filters, cursor })).not.toThrow();
    // Surrounding whitespace in the query is ignored.
    expect(() => plan({ ...body, query: ' a ', cursor })).not.toThrow();
    // A filter's key order doesn't matter.
    expect(() => plan({ ...body, filters: [{ value: 'x', op: 'eq', field: 'name' }], cursor })).not.toThrow();

    const mismatch = /cursor does not match/;
    rejects({ ...body, query: 'b', cursor }, mismatch);
    rejects({ ...body, filters: [], cursor }, mismatch);
    rejects({ ...body, filters: [{ field: 'name', op: 'eq', value: 'y' }], cursor }, mismatch);
    rejects({ ...body, sort: [{ field: 'name', desc: true }], cursor }, mismatch);
    rejects({ ...body, sort: [{ field: 'name' }, { field: 'count' }], cursor }, mismatch);
  });

  test('reject a forged or malformed cursor', () => {
    const body = { sort: [{ field: 'count' }] };
    const good = JSON.parse(Buffer.from(cursorAfter(body, { id: 'k', count: 1 }), 'base64url').toString());
    const forge = (v: unknown[]) => Buffer.from(JSON.stringify({ f: good.f, v })).toString('base64url');
    for (const cursor of [
      'not a cursor',
      '!!!',
      Buffer.from('[]').toString('base64url'),
      Buffer.from('{"f":1,"v":[]}').toString('base64url'),
      forge([1]),
      forge(['1', 'k']),
      forge([1.5, 'k']),
      forge([1, 2]),
      forge([null, 'k']),
      forge([1, 'k', 'extra']),
    ]) {
      rejects({ ...body, cursor }, /invalid cursor/);
    }
    expect(() => plan({ ...body, cursor: forge([1, 'k']) })).not.toThrow();
  });
});
