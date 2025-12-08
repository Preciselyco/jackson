import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const { directorySyncController: dsync } = await jackson();

  const { data, error } = await dsync.directories.getAll();
  if (error) {
    res.status(error.code).json(error);
    return;
  }
  res.status(200).json(data);
}
