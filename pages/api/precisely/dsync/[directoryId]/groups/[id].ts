import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { GroupMembership } from '@boxyhq/saml-jackson';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { directorySyncController: dsync } = await jackson();

  const { data: directory, error: dirErr } = await dsync.directories.get(req.query.directoryId as string);
  if (dirErr) {
    res.status(dirErr.code).json(dirErr);
    return;
  }

  const groupAPI = dsync.groups.setTenantAndProduct(directory.tenant, directory.product);

  const { data: group, error: groupErr } = await groupAPI.get(req.query.id as string);
  if (groupErr) {
    res.status(groupErr.code).json(groupErr);
    return;
  }

  let pageOffset = 0;
  let members: Pick<GroupMembership, 'user_id'>[] = [];

  while (true) {
    const { data, error: memErr } = await groupAPI.getGroupMembers({
      groupId: group.id as string,
      pageLimit: 25,
      pageOffset,
    });
    pageOffset += 25;
    if (memErr) {
      continue;
    }
    if (!data || data.length == 0) {
      break;
    }
    members.push(...data);
  }

  res.status(200).json({ group, members });
}
