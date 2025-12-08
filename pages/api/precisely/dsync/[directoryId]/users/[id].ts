import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { directorySyncController: dsync } = await jackson();

  const { data: directory, error: dirErr } = await dsync.directories.get(req.query.directoryId as string);
  if (dirErr) {
    res.status(dirErr.code).json(dirErr);
    return;
  }

  const userAPI = dsync.users.setTenantAndProduct(directory.tenant, directory.product);

  const { data: user, error: userErr } = await userAPI.get(req.query.id as string);
  if (userErr) {
    res.status(userErr.code).json(userErr);
    return;
  }

  res.status(200).json({ user });
}
