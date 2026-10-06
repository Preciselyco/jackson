import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { allowGet } from '@lib/precisely';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

  const { directorySyncController: dsync } = await jackson();

  const { data, error } = await dsync.directories.getAll();
  if (error) {
    res.status(error.code).json(error);
    return;
  }
  res.status(200).json(
    data.map(({ id, name, tenant, product, type, deactivated }) => ({
      id,
      name,
      tenant,
      product,
      type,
      deactivated,
    }))
  );
}
