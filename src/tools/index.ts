import { accountTools } from './account.js';
import { messagingTools } from './messaging.js';
import { peopleTools } from './people.js';
import type { ToolContext, ToolDef } from './types.js';

export type { ToolContext, ToolDef } from './types.js';

export const SERVER_INSTRUCTIONS =
  'linksmcp, door-contract 1.0. Your own LinkedIn account through your own session cookie, on this machine. ' +
  'If get_linkedin_status says disconnected, ask the user for the li_at cookie from their browser and call connect_linkedin. ' +
  'One recipient per send: to.contact_id (a chat_id from list_chats), to.linkedin_username or to.profile_url. There is no bulk tool. ' +
  'Limits are enforced locally (daily caps, working hours, pacing, no links to people who have not written back); a refusal returns JSON with error_code and nothing is sent or queued. ' +
  'Use wait_for_messages with the returned cursor to follow new inbound messages.';

/** The registration table. The contract parity test reads it through the MCP tools/list call. */
export function buildTools(ctx: ToolContext): ToolDef[] {
  return [...accountTools(ctx), ...messagingTools(ctx), ...peopleTools(ctx)];
}
