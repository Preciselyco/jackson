import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { allowGet, sendError } from '@lib/precisely';
import { preciselySql } from '@lib/precisely/db';
import { DirectoryNotFoundError, directorySummary, getDirectory } from '@lib/precisely/dsync';

// GET /api/precisely/dsync/:directoryId/summary — the directory with its user and group
// counts. See PRECISELY.md.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

  try {
    const sql = await preciselySql(await jackson());
    const directory = await getDirectory(sql, req.query.directoryId as string);
    if (!directory) {
      sendError(res, new DirectoryNotFoundError());
      return;
    }
    res.status(200).json(await directorySummary(sql, directory));
  } catch (err: any) {
    sendError(res, err);
  }
}
