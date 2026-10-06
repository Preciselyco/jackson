import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { GroupMembership } from '@boxyhq/saml-jackson';
import { allowGet, fetchAllPages, sendError } from '@lib/precisely';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!allowGet(req, res)) return;

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

  try {
    const members = await fetchAllPages<Pick<GroupMembership, 'user_id'>>((page) =>
      groupAPI.getGroupMembers({ groupId: group.id as string, ...page })
    );
    res.status(200).json({ group, members });
  } catch (err: any) {
    sendError(res, err);
  }
}
