import jackson from '@lib/jackson';
import type { NextApiRequest, NextApiResponse } from 'next';
import { allowGet, sendError } from '@lib/precisely';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

  const { connectionAPIController: connAPI } = await jackson();

  try {
    const conns = await connAPI.getConnections({
      clientID: req.query.clientID as string,
    });
    if (!conns[0]) {
      res.status(404).json({ error: { message: 'Connection not found' } });
      return;
    }
    const { clientID, clientSecret } = conns[0];
    res.status(200).json({ conn: { clientID, clientSecret } });
  } catch (err: any) {
    sendError(res, err);
  }
}
