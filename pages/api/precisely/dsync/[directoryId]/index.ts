import jackson from '@lib/jackson';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Groups } from '@boxyhq/saml-jackson/src/directory-sync/scim/Groups';
import { Users } from '@boxyhq/saml-jackson/src/directory-sync/scim/Users';
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
  const groupAPI = dsync.groups.setTenantAndProduct(directory.tenant, directory.product);

  let users: Record<string, any>;
  let groups: Record<string, any>;
  let members: { group_id: string; user_id: string }[][];
  try {
    [users, groups] = await Promise.all([
      fetchUsers(userAPI, directory.id),
      fetchGroups(groupAPI, directory.id),
    ]);
    members = await Promise.all(Object.keys(groups).map((groupId) => fetchMembers(groupAPI, groupId)));
  } catch (err: any) {
    sendError(res, err);
    return;
  }

  members.flat().forEach((m) => {
    const u = users[m.user_id];
    const g = groups[m.group_id];
    if (!u || !g) return;

    u.groups.push(g.name);
    g.members.push(u.email);
  });

  res.status(200).json({
    id: directory.id,
    name: directory.name,
    tenant: directory.tenant,
    product: directory.product,
    type: directory.type,
    users: Object.values(users).sort((a, b) => {
      if (a.email < b.email) return -1;
      if (a.email > b.email) return 1;
      return 0;
    }),
    groups: Object.values(groups).sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    }),
  });
}

async function fetchUsers(userAPI: Users, directoryId: string) {
  const users: Record<string, any> = {};
  const data = await fetchAllPages((page) => userAPI.getAll({ directoryId, ...page }));

  data.forEach((u) => {
    users[u.id] = {
      id: u.id,
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
      active: u.active,
      groups: [],
    };
  });

  return users;
}

async function fetchGroups(groupAPI: Groups, directoryId: string) {
  const groups: Record<string, any> = {};
  const data = await fetchAllPages((page) => groupAPI.getAll({ directoryId, ...page }));

  data.forEach((g) => {
    groups[g.id] = {
      id: g.id,
      name: g.name,
      members: [],
    };
  });

  return groups;
}

async function fetchMembers(groupAPI: Groups, groupId: string) {
  const data = await fetchAllPages((page) => groupAPI.getGroupMembers({ groupId, ...page }));

  return data.map(({ user_id }) => ({ user_id, group_id: groupId }));
}
