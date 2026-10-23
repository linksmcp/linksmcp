import { z } from 'zod';
import { ACCOUNT_ID, ToolError } from '../wire.js';
import { json, wrap, type ToolContext, type ToolDef } from './types.js';

const accountIdRequired = z.string().describe('The account id from connect_linkedin or list_accounts ("local" on self-hosted servers).');

export function accountTools({ door }: ToolContext): ToolDef[] {
  const mustBeLocal = (id: unknown) => {
    if (id !== ACCOUNT_ID) throw new ToolError('account_not_found', `Unknown account_id "${String(id)}". This server has one account: "${ACCOUNT_ID}".`);
  };

  return [
    {
      name: 'list_accounts',
      title: 'List accounts',
      description: 'List the LinkedIn accounts on this server. A self-hosted linksmcp has exactly one account, id "local".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () =>
        json({ accounts: [door.wireAccount()], channels: [{ channel: 'linkedin', label: 'LinkedIn', connect_kind: 'cookie', max_accounts: 1 }] }),
      ),
    },
    {
      name: 'get_usage',
      title: 'Usage and limits',
      description:
        "Today's counts and daily limits: messages, new threads, connection requests, profile views, searches, accepted invitations, working hours and when the next write may happen. " +
        'status is suspended while writes are paused (48 h after a LinkedIn check, or until fresh cookies replace expired ones). Days are local calendar days.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => json(door.usage())),
    },
    {
      name: 'connect_linkedin',
      title: 'Connect LinkedIn',
      description:
        'Connect your own LinkedIn account from the cookies of a browser where you are signed in: export the cookies for linkedin.com as JSON (a cookie export extension does this) and pass them as cookie_jar. ' +
        'li_at alone is accepted as a shortcut. The cookies are checked with LinkedIn at once: the answer is connected or failed with the reason. They are stored only on this machine (auth.json, mode 600). ' +
        'country is accepted and stored, nothing else.',
      inputSchema: {
        cookie_jar: z
          .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
          .optional()
          .describe('The cookies of a signed-in LinkedIn browser session, as the JSON a cookie export extension produces (an array of {name, value, domain, ...}), or that JSON as a string.'),
        country: z.string().optional().describe('Two-letter country code of where this account is normally used. Stored, not used.'),
        city: z.string().optional().describe('Accepted and ignored on self-hosted servers.'),
        country_confirmation: z.enum(['kept', 'switched']).optional().describe('Accepted and ignored on self-hosted servers.'),
        browser_timezone: z.string().optional().describe('The IANA timezone of the browser the cookies came from, when known.'),
        account_id: z.string().optional().describe('Reconnect this account ("local").'),
        li_at: z.string().optional().describe('Self-hosted shortcut: the li_at cookie value instead of cookie_jar.'),
        jsessionid: z.string().optional().describe('Self-hosted: the JSESSIONID cookie value; fetched when absent.'),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
      handler: wrap(async ({ cookie_jar, country, account_id, li_at, jsessionid }) => {
        if (account_id !== undefined) mustBeLocal(account_id);
        return json(await door.connect({ cookie_jar, country, li_at, jsessionid }));
      }),
    },
    {
      name: 'get_linkedin_status',
      title: 'LinkedIn status',
      description:
        'The LinkedIn account status: connected, failed (the stored cookies no longer sign in; error says why) or disconnected (no cookies stored). ' +
        "Adds limits (today's counts and caps) and hint, for example while writes are paused for 48 hours after a LinkedIn check.",
      inputSchema: { account_id: accountIdRequired },
      annotations: { readOnlyHint: true },
      handler: wrap(async ({ account_id }) => {
        mustBeLocal(account_id);
        return json(door.linkedinStatus(true));
      }),
    },
    {
      name: 'submit_linkedin_code',
      title: 'Submit a LinkedIn code',
      description: 'Hosted sign-ins can ask for a verification code. A self-hosted server signs in with cookies only and never asks for one, so this answers invalid_request.',
      inputSchema: { account_id: accountIdRequired, code: z.string() },
      annotations: { idempotentHint: true },
      handler: wrap(async ({ account_id }) => {
        mustBeLocal(account_id);
        throw new ToolError('invalid_request', 'No sign-in is waiting for a code on a self-hosted server.');
      }),
    },
    {
      name: 'disconnect_linkedin',
      title: 'Disconnect LinkedIn',
      description: 'Delete the stored cookies. The LinkedIn account itself is untouched; a running 48 hour pause stays in force.',
      inputSchema: { account_id: accountIdRequired },
      annotations: { destructiveHint: true, idempotentHint: true },
      handler: wrap(async ({ account_id }) => {
        mustBeLocal(account_id);
        door.disconnect();
        return json({ disconnected: true, account_id: ACCOUNT_ID });
      }),
    },
  ];
}
