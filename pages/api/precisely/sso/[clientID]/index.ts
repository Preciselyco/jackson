import jackson from '@lib/jackson';
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { connectionAPIController: connAPI } = await jackson();

  try {
    const conns = await connAPI.getConnections({
      clientID: req.query.clientID as string,
    });
    res.status(200).json({ conn: conns[0] });
  } catch (err: any) {
    res.status(err.statusCode).json(err);
  }
}
