import type { NextApiRequest, NextApiResponse } from 'next';
import { allowGet } from '@lib/precisely';

type ResponseData = {};

export default function handler(req: NextApiRequest, res: NextApiResponse<ResponseData>) {
  if (!allowGet(req, res)) return;
  res.status(200).json({});
}
