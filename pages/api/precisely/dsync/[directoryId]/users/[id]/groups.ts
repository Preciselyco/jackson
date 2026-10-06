import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { Group } from '@boxyhq/saml-jackson';
import { allowGet, fetchAllPages, sendError } from '@lib/precisely';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

  const { directorySyncController: dsync } = await jackson();

  const { data: directory, error: dirErr } = await dsync.directories.get(req.query.directoryId as string);
  if (dirErr) {
    res.status(dirErr.code).json(dirErr);
    return;
  }

  const groupAPI = dsync.groups.setTenantAndProduct(directory.tenant, directory.product);

  try {
    const all = await fetchAllPages<Group>((page) => groupAPI.getAll({ directoryId: directory.id, ...page }));

    const groups: Group[] = [];
    for (const group of all) {
      if (await groupAPI.isUserInGroup(group.id, req.query.id as string)) {
        groups.push(group);
      }
    }

    res.status(200).json({ groups });
  } catch (err: any) {
    sendError(res, err);
  }
}
