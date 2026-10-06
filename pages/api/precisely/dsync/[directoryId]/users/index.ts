import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { User } from '@boxyhq/saml-jackson';
import { allowGet, fetchAllPages, sendError } from '@lib/precisely';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

  const { directorySyncController: dsync } = await jackson();

  const { data: directory, error: dirErr } = await dsync.directories.get(req.query.directoryId as string);
  if (dirErr) {
    res.status(dirErr.code).json(dirErr);
    return;
  }

  const userAPI = dsync.users.setTenantAndProduct(directory.tenant, directory.product);

  try {
    const users = await fetchAllPages<User>((page) => userAPI.getAll({ directoryId: directory.id, ...page }));
    res.status(200).json({ users });
  } catch (err: any) {
    sendError(res, err);
  }
}
