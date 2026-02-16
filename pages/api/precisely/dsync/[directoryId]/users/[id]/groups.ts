import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { Group } from '@boxyhq/saml-jackson';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { directorySyncController: dsync } = await jackson();

  const { data: directory, error: dirErr } = await dsync.directories.get(req.query.directoryId as string);
  if (dirErr) {
    res.status(dirErr.code).json(dirErr);
    return;
  }

  const groupAPI = dsync.groups.setTenantAndProduct(directory.tenant, directory.product);
  let pageOffset = 0;
  let groups: Group[] = [];

  while (true) {
    const { data, error: groupErr } = await groupAPI.getAll({
      directoryId: directory.id,
      pageLimit: 25,
      pageOffset,
    });
    pageOffset += 25;
    if (groupErr) {
      continue;
    }
    if (!data || data.length == 0) {
      break;
    }

    for (let group of data) {
      if (await groupAPI.isUserInGroup(group.id, req.query.id as string)) {
        groups.push(group);
      }
    }
  }

  res.status(200).json({ groups });
}
