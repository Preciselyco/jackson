import jackson from '@lib/jackson';
import { Storable, Encrypted } from '@boxyhq/saml-jackson';
import type { NextApiRequest, NextApiResponse } from 'next';
import { decrypt } from '@boxyhq/saml-jackson/src/db/encrypter';

function _decrypt(res: Encrypted, encryptionKey: string) {
  const encKey = Buffer.from(encryptionKey, 'hex');
  if (res.iv && res.tag) {
    return JSON.parse(decrypt(res.value, res.iv, res.tag, encKey));
  }
  return JSON.parse(res.value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
    res.status(200).json({ conn: conns[0] });
  } catch (err: any) {
    res.status(err.statusCode).json(err);
  }
}
