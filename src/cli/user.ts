// `site-admin user {invite,list,remove}` — manage the invite allowlist
// and inspect existing users.

import { paths } from '../lib/config.ts';
import { open } from '../lib/db.ts';
import { migrate } from '../lib/migrate.ts';
import {
  inviteEmail,
  isAllowed,
  listInvites,
  listUsers,
  type Role,
  removeInvite
} from '../lib/users.ts';

const SUBCOMMANDS = ['invite', 'list', 'remove'] as const;
type UserSub = (typeof SUBCOMMANDS)[number];

function parseArgs(argv: string[]): { sub: UserSub; rest: string[] } {
  const sub = argv[0];
  if (!sub || !SUBCOMMANDS.includes(sub as UserSub)) {
    throw new Error(`usage: site-admin user <${SUBCOMMANDS.join('|')}> [args]`);
  }
  return { sub: sub as UserSub, rest: argv.slice(1) };
}

function parseRole(s: string | undefined): Role {
  if (s === undefined) return 'editor';
  if (s !== 'owner' && s !== 'editor') {
    throw new Error(`role must be one of owner|editor (got ${s})`);
  }
  return s;
}

export default async function userCmd(argv: string[]): Promise<void> {
  const { sub, rest } = parseArgs(argv);
  const p = paths();
  const db = open(p.db);
  try {
    migrate(db);
    if (sub === 'invite') return invite(db, rest);
    if (sub === 'remove') return remove(db, rest);
    return list(db);
  } finally {
    db.close();
  }
}

function invite(db: ReturnType<typeof open>, rest: string[]): void {
  const email = rest[0];
  if (!email) throw new Error('usage: site-admin user invite <email> [--role owner|editor]');
  const roleIdx = rest.indexOf('--role');
  const role = parseRole(roleIdx >= 0 ? rest[roleIdx + 1] : undefined);
  inviteEmail(db, email, role);
  console.log(`invited ${email.toLowerCase()} as ${role}`);
}

function remove(db: ReturnType<typeof open>, rest: string[]): void {
  const email = rest[0];
  if (!email) throw new Error('usage: site-admin user remove <email>');
  const removed = removeInvite(db, email);
  if (removed) {
    console.log(`removed invite ${email.toLowerCase()}`);
    return;
  }
  // Maybe they meant a real user — surface as a warning rather than failing.
  if (!isAllowed(db, email)) {
    console.log(`no invite found for ${email.toLowerCase()}`);
  }
}

function list(db: ReturnType<typeof open>): void {
  const invites = listInvites(db);
  const users = listUsers(db);

  console.log(`users (${users.length}):`);
  for (const u of users) {
    const seen = u.last_seen_at ? `last seen ${u.last_seen_at}` : 'never seen';
    console.log(
      `  [${u.role}] ${u.email}${u.display_name ? ` (${u.display_name})` : ''} — ${seen}`
    );
  }

  console.log(`\ninvites (${invites.length}):`);
  for (const inv of invites) {
    console.log(`  [${inv.role}] ${inv.email}  invited ${inv.invited_at}`);
  }
}
