import { z } from 'zod';
import { json, wrap, type ToolContext, type ToolDef } from './types.js';

export function accountTools({ door }: ToolContext): ToolDef[] {
  return [
    {
      name: 'list_accounts',
      title: 'List accounts',
      description: 'List the LinkedIn accounts on this server. A self-hosted linksmcp has exactly one account, id "local".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => json({ accounts: [door.wireAccount()] })),
    },
    {
      name: 'get_usage',
      title: 'Usage and limits',
      description:
        "Today's counts and daily limits: messages, new threads, connection requests, profile views, searches, accepted invitations, working hours and when the next write may happen. Days are local calendar days.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => json(door.usage())),
    },
    {
      name: 'connect_linkedin',
      title: 'Connect LinkedIn',
      description:
        'Sign in with the li_at cookie of your own LinkedIn session (in your browser: linkedin.com, developer tools, Application, Cookies, li_at). ' +
        'jsessionid is optional and fetched when absent. The cookie is checked with LinkedIn and stored only on this machine (auth.json, mode 600).',
      inputSchema: {
        li_at: z.string().describe('Value of the li_at cookie.'),
        jsessionid: z.string().optional().describe('Optional; fetched when absent. The JSESSIONID cookie value without quotes.'),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
      handler: wrap(async ({ li_at, jsessionid }) => json(await door.connect(li_at, jsessionid))),
    },
    {
      name: 'get_linkedin_status',
      title: 'LinkedIn status',
      description: 'Get the LinkedIn account status: connected, disconnected (no cookie or the cookie expired) or restricted (writes paused for 48 hours after a LinkedIn check).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => json(door.wireAccount())),
    },
    {
      name: 'disconnect_linkedin',
      title: 'Disconnect LinkedIn',
      description: 'Forget the stored cookie. LinkedIn itself is not signed out; sign out in the browser to end the session there.',
      inputSchema: {},
      annotations: { destructiveHint: true, idempotentHint: true },
      handler: wrap(async () => {
        door.disconnect();
        return json({ disconnected: true });
      }),
    },
  ];
}
