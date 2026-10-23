import { z } from 'zod';
import { resolveUsername } from '../linkedin/ids.js';
import { acceptInvitation, listInvitations, sendInvitation } from '../linkedin/invitations.js';
import { getDistance, getProfile } from '../linkedin/profile.js';
import { searchPeople } from '../linkedin/search.js';
import { ToolError } from '../wire.js';
import { json, limitArg, queryArg, wrap, type ToolContext, type ToolDef } from './types.js';

const linkedinUrl = z.string().optional().describe("The person's LinkedIn profile URL, https://www.linkedin.com/in/...");
const username = z.string().optional().describe('Self-hosted shortcut: the public id from the profile URL.');

export function peopleTools({ door }: ToolContext): ToolDef[] {
  const { store } = door;

  return [
    {
      name: 'get_my_profile',
      title: 'My profile',
      description: 'Read your own LinkedIn profile.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async () => {
        const c = await door.client();
        const id = store.account().identifier;
        if (!id) throw new ToolError('no_connected_account', 'Your public id is not known yet. Call connect_linkedin again.');
        const p = await door.guard(() => getProfile(c, id));
        const { urn_id: _u, ...out } = p;
        return json(out);
      }),
    },
    {
      name: 'get_person_profile',
      title: 'Read a profile',
      description: 'Read one LinkedIn profile by public id or profile URL, with your connection degree (1, 2, 3). Counts as a profile view.',
      inputSchema: { linkedin_url: linkedinUrl, linkedin_username: username },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async (args) => {
        const u = resolveUsername(args);
        door.checkRead('profile_view');
        const c = await door.client();
        const p = await door.guard(() => getProfile(c, u));
        door.record(['profile_view'], p.linkedin_username);
        const degree = await door.guard(() => getDistance(c, p.linkedin_username)).catch(() => null);
        if (p.urn_id) {
          store.upsertContact({ id: p.urn_id, username: p.linkedin_username, name: p.name, headline: p.headline, distance: degree, thread_id: null, updated_at: door.now().getTime() });
        }
        const { urn_id: _u, ...out } = p;
        return json({ ...out, connection_degree: degree });
      }),
    },
    {
      name: 'search_people',
      title: 'Search people',
      description:
        'Find people by keywords (one LinkedIn search page, up to 10 people per page). location and current_company take LinkedIn ids (geo id, company id) as filters; other text is added to the keywords. ' +
        'Use next_start for the next page. Counts as a search.',
      inputSchema: {
        keywords: z.string().describe('2 to 200 characters.'),
        location: z.string().optional().describe('Up to 200 characters.'),
        current_company: z.string().optional().describe('Up to 200 characters.'),
        limit: z.number().int().optional().describe('1 to 25, default 10.'),
        start: z.number().int().optional().describe('Offset, 0 or more, default 0.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async (args) => {
        const keywords = queryArg(args.keywords, 2, 200, true)!;
        const location = queryArg(args.location, 0, 200, false) || undefined;
        const current_company = queryArg(args.current_company, 0, 200, false) || undefined;
        const limit = limitArg(args.limit, 1, 25, 10);
        if (args.start !== undefined && (!Number.isInteger(args.start) || args.start < 0)) throw new ToolError('invalid_limit', 'start must be a whole number, 0 or more.');
        const start: number = args.start ?? 0;
        door.checkRead('search');
        const c = await door.client();
        const out = await door.guard(() => searchPeople(c, { keywords, location, current_company, start, limit }, door.config().search_query_id));
        door.record(['search'], keywords);
        if (!out.people.length && start === 0) {
          return json({
            ...out,
            note: 'No results. If searches that used to work now return nothing, LinkedIn may have changed its search query id: set LINKSMCP_SEARCH_QUERY_ID or search_query_id in config.json.',
          });
        }
        return json(out);
      }),
    },
    {
      name: 'connect_with_person',
      title: 'Send a connection request',
      description:
        'Send a LinkedIn connection request to one person, with an optional note (300 characters, no links). Counts as an invitation. ' +
        'Daily limit, working hours and a 5 to 8 minute gap between requests apply.',
      inputSchema: {
        linkedin_url: linkedinUrl,
        linkedin_username: username,
        note: z.string().max(300).optional(),
      },
      annotations: { openWorldHint: true },
      handler: wrap(async ({ linkedin_url, linkedin_username, note }) => {
        const u = resolveUsername({ linkedin_url, linkedin_username });
        const text = typeof note === 'string' ? note.trim() : '';
        door.precheckWrite({ kind: 'invite', text });
        const person = await door.person(u, { needDistance: true });
        if (person.id === store.account().urn_id) throw new ToolError('invalid_recipient', 'That is your own profile.');
        if (person.distance === 1) return json({ status: 'already_connected' });
        await door.gateWrite({ kind: 'invite', text });
        const c = await door.client();
        const r = await door.guard(() => sendInvitation(c, person.id, text));
        if (r.status === 'sent') door.recordWrite('invite', [], person.username ?? u);
        return json(r);
      }),
    },
    {
      name: 'list_invitations',
      title: 'List invitations',
      description: 'List sent or received connection invitations that are still pending.',
      inputSchema: {
        direction: z.enum(['sent', 'received']),
        limit: z.number().int().optional().describe('1 to 100, default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: wrap(async ({ direction, limit }) => {
        const n = limitArg(limit, 1, 100, 20);
        const c = await door.client();
        const invs = await door.guard(() => listInvitations(c, direction, n));
        for (const i of invs) {
          store.upsertInvitation({ id: i.id, direction: i.direction, shared_secret: i.shared_secret, username: i.linkedin_username, name: i.name, sent_at: i.sent_at, note: i.note ?? null });
        }
        return json({ invitations: invs.map(({ shared_secret: _s, ...rest }) => rest) });
      }),
    },
    {
      name: 'accept_invitation',
      title: 'Accept an invitation',
      description: 'Accept a received connection invitation (id from list_invitations). Counts as an accept.',
      inputSchema: { invitation_id: z.string() },
      annotations: { openWorldHint: true },
      handler: wrap(async ({ invitation_id }) => {
        door.precheckWrite({ kind: 'accept' });
        let row = store.invitation(invitation_id);
        const c = await door.client();
        if (!row?.shared_secret) {
          const invs = await door.guard(() => listInvitations(c, 'received', 100));
          for (const i of invs) {
            store.upsertInvitation({ id: i.id, direction: i.direction, shared_secret: i.shared_secret, username: i.linkedin_username, name: i.name, sent_at: i.sent_at, note: i.note ?? null });
          }
          row = store.invitation(invitation_id);
        }
        if (!row || row.direction !== 'received' || !row.shared_secret) {
          throw new ToolError('contact_not_found', `No pending received invitation with id ${invitation_id}. Use list_invitations with direction received.`);
        }
        await door.gateWrite({ kind: 'accept' });
        await door.guard(() => acceptInvitation(c, invitation_id, row!.shared_secret!));
        door.recordWrite('accept', [], row.username);
        return json({ accepted: true });
      }),
    },
  ];
}
