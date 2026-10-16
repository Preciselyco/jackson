import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { allowPost, sendError } from '@lib/precisely';
import { preciselySql } from '@lib/precisely/db';
import { lookupUsersByEmail } from '@lib/precisely/dsync';
import { fail, isObject, jsonBody } from '@lib/precisely/list';

const maxDirectoryIds = 100;

// POST /api/precisely/dsync/users/lookup — every directory user with an email, across
// directories, with their groups. Body: { email, directoryIds? }. See PRECISELY.md.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowPost(req, res)) return;

  try {
    const { email, directoryIds } = parseLookup(jsonBody(req.body));
    const sql = await preciselySql(await jackson());
    res.status(200).json({ matches: await lookupUsersByEmail(sql, email, directoryIds) });
  } catch (err: any) {
    sendError(res, err);
  }
}

function parseLookup(body: unknown): { email: string; directoryIds?: string[] } {
  if (!isObject(body)) {
    fail('invalid request body: not a JSON object');
  }
  const obj = body as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'email' && k !== 'directoryIds') fail(`invalid request body: unknown field "${k}" in request`);
    if (v === null) fail(`invalid request body: ${k} must not be null`);
  }
  if (typeof obj.email !== 'string' || obj.email.trim() === '') {
    fail('email must be a non-empty string');
  }
  if (!('directoryIds' in obj)) {
    return { email: obj.email as string };
  }
  const ids = obj.directoryIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    fail('directoryIds must be an array of strings');
  }
  if ((ids as string[]).length > maxDirectoryIds) {
    fail(`directoryIds takes at most ${maxDirectoryIds} values`);
  }
  return { email: obj.email as string, directoryIds: ids as string[] };
}
