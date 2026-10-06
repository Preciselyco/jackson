import { test, expect } from '@playwright/test';

// /api/precisely/** is Precisely's internal API. It must only answer callers that present
// one of the configured API keys.

// No admin session: only the API key may grant access.
test.use({ storageState: { cookies: [], origins: [] } });

const apiKey = (process.env.API_KEYS || process.env.JACKSON_API_KEYS || '').split(',')[0];
const withKey = { Authorization: `Bearer ${apiKey}` };

test.describe('/api/precisely authentication', () => {
  test('rejects a request without an API key', async ({ request }) => {
    const response = await request.get('/api/precisely/dsync');
    expect(response.status()).toBe(401);
  });

  test('rejects a request with a wrong API key', async ({ request }) => {
    const response = await request.get('/api/precisely/dsync', {
      headers: { Authorization: 'Bearer not-the-api-key' },
    });
    expect(response.status()).toBe(401);
  });

  test('rejects the bare prefix without an API key', async ({ request }) => {
    const response = await request.get('/api/precisely');
    expect(response.status()).toBe(401);
  });

  test('accepts a request with a valid API key', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const response = await request.get('/api/precisely/dsync', { headers: withKey });
    expect(response.status()).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  for (const path of [
    '/api/precisely/%64sync',
    '/api//precisely/dsync',
    '/API/precisely/dsync',
    '/api/precisely/dsync/',
    '/api/precisely/',
  ]) {
    test(`never answers ${path} without an API key`, async ({ request }) => {
      const followed = await request.get(path);
      expect(followed.status()).not.toBe(200);

      const unfollowed = await request.get(path, { maxRedirects: 0 });
      expect(unfollowed.status()).not.toBe(200);
    });
  }
});

test.describe('/api/precisely handlers', () => {
  test('reject methods other than GET', async ({ request }) => {
    const response = await request.post('/api/precisely/dsync', { headers: withKey });
    expect(response.status()).toBe(405);
  });

  test('answer an unknown SSO client ID with 404', async ({ request }) => {
    const response = await request.get('/api/precisely/sso/no-such-client-id', { headers: withKey });
    expect(response.status()).toBe(404);
  });
});
