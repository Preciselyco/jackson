import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { User } from '@boxyhq/saml-jackson';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { directorySyncController: dsync } = await jackson();

  const { data: directory, error: dirErr } = await dsync.directories.get(req.query.directoryId as string);
  if (dirErr) {
    res.status(dirErr.code).json(dirErr);
    return;
  }

  const userAPI = dsync.users.setTenantAndProduct(directory.tenant, directory.product);

  let pageOffset = 0;
  let users: User[] = [];

  while (true) {
    const { data, error: userErr } = await userAPI.getAll({
      directoryId: directory.id,
      pageLimit: 25,
      pageOffset,
    });
    pageOffset += 25;
    if (userErr) {
      continue;
    }
    if (!data || data.length == 0) {
      break;
    }
    users.push(...data);
  }

  res.status(200).json({ users });
}
