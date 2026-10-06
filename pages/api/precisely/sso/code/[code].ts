import jackson from '@lib/jackson';
import { Storable, Encrypted } from '@boxyhq/saml-jackson';
import type { NextApiRequest, NextApiResponse } from 'next';
import { decrypt } from '@boxyhq/saml-jackson/src/db/encrypter';
import { allowGet, sendError } from '@lib/precisely';

function _decrypt(res: Encrypted, encryptionKey: string) {
  const encKey = Buffer.from(encryptionKey, 'hex');
  if (res.iv && res.tag) {
    return JSON.parse(decrypt(res.value, res.iv, res.tag, encKey));
  }
  return JSON.parse(res.value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

  const { connectionAPIController: connAPI, oauthController: oauth } = await jackson();
  const codeStore = (oauth as any).codeStore as Storable;

  try {
    const codes = (req.query.code as string).split('.');
    const encCode = await codeStore.get(codes[1]);
    if (!encCode) {
      res.status(404).send('');
      return;
    }
    const code = _decrypt(encCode, codes[0]);

    const conns = await connAPI.getConnections({
      clientID: code.clientID,
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
