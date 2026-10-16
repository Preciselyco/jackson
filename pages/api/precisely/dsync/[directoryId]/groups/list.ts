import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { allowPost, sendError } from '@lib/precisely';
import { preciselySql } from '@lib/precisely/db';
import { DirectoryNotFoundError, getDirectory, listGroups } from '@lib/precisely/dsync';
import { parseListRequest } from '@lib/precisely/list';

// POST /api/precisely/dsync/:directoryId/groups/list — a page of the directory's groups
// under the backoffice v2 list contract. See PRECISELY.md.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowPost(req, res)) return;

  try {
    const listReq = parseListRequest(req.body);
    const sql = await preciselySql(await jackson());
    const directory = await getDirectory(sql, req.query.directoryId as string);
    if (!directory) {
      sendError(res, new DirectoryNotFoundError());
      return;
    }
    res.status(200).json(await listGroups(sql, directory, listReq));
  } catch (err: any) {
    sendError(res, err);
  }
}
