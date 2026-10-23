import { LinkedInHttpError, type LinkedInClient } from './client.js';
import { Graph, num, str, urnId, type Obj } from './normalize.js';
import { memberOf } from './messaging.js';
import { profileUrlFor } from '../wire.js';

export interface Invitation {
  id: string;
  direction: 'sent' | 'received';
  linkedin_username: string | null;
  linkedin_url: string | null;
  name: string | null;
  sent_at: string | null;
  note?: string;
  /** Needed to accept; never returned to the agent. */
  shared_secret: string | null;
}

export function parseInvitations(json: unknown, direction: 'sent' | 'received'): Invitation[] {
  const g = new Graph(json);
  let invs: Obj[] = g
    .elements()
    .map((v) => g.get(v, 'invitation') ?? (v.entityUrn && String(v.entityUrn).includes('nvitation') ? v : undefined))
    .filter(Boolean);
  if (!invs.length) invs = g.ofType('.invitation.Invitation');
  const out: Invitation[] = [];
  for (const inv of invs) {
    const id = urnId(inv.entityUrn) ?? str(inv.invitationId) ?? (num(inv.invitationId) !== undefined ? String(inv.invitationId) : undefined);
    if (!id) continue;
    const person = memberOf(g, g.get(inv, direction === 'received' ? 'fromMember' : 'toMember') ?? g.get(inv, 'fromMember') ?? g.get(inv, 'toMember'));
    const sent = num(inv.sentTime);
    const i: Invitation = {
      id,
      direction,
      linkedin_username: person?.linkedin_username ?? null,
      linkedin_url: person?.linkedin_username ? profileUrlFor(person.linkedin_username) : null,
      name: person?.name ?? null,
      sent_at: sent ? new Date(sent).toISOString() : null,
      shared_secret: str(inv.sharedSecret) ?? null,
    };
    const note = str(inv.message) ?? str(inv.customMessage);
    if (note) i.note = note;
    out.push(i);
  }
  return out;
}

export async function listInvitations(c: LinkedInClient, direction: 'sent' | 'received', count: number): Promise<Invitation[]> {
  const json =
    direction === 'received'
      ? await c.request('/relationships/invitationViews', { query: `start=0&count=${count}&includeInsights=true&q=receivedInvitation` })
      : await c.request('/relationships/sentInvitationViewsV2', { query: `start=0&count=${count}&invitationType=CONNECTION&q=invitationType` });
  return parseInvitations(json, direction).slice(0, count);
}

export async function acceptInvitation(c: LinkedInClient, id: string, sharedSecret: string): Promise<void> {
  await c.request(`/relationships/invitations/${encodeURIComponent(id)}`, {
    method: 'POST',
    query: 'action=accept',
    body: { invitationId: id, invitationSharedSecret: sharedSecret, isGenericInvitation: false },
  });
}

export const INVITE_DECORATION = 'com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2';

/** Finds an invitation id anywhere in the create answer. */
export function parseInviteResult(json: unknown): string | null {
  const m = /urn:li:(?:fsd_invitation|fs_relInvitation|invitation):([A-Za-z0-9_-]+)/.exec(JSON.stringify(json ?? {}));
  return m ? m[1] : null;
}

/** Sends a connection request. "pending" when LinkedIn says one is already waiting. */
export async function sendInvitation(c: LinkedInClient, memberUrnId: string, note: string): Promise<{ status: 'sent' | 'pending'; invitation_id?: string }> {
  try {
    const json = await c.request('/voyagerRelationshipsDashMemberRelationships', {
      method: 'POST',
      query: `action=verifyQuotaAndCreateV2&decorationId=${INVITE_DECORATION}`,
      body: { invitee: { inviteeUnion: { memberProfile: `urn:li:fsd_profile:${memberUrnId}` } }, customMessage: note },
    });
    const id = parseInviteResult(json);
    return id ? { status: 'sent', invitation_id: id } : { status: 'sent' };
  } catch (err) {
    if (err instanceof LinkedInHttpError && err.status === 400 && /CANT_RESEND_YET/i.test(err.body)) return { status: 'pending' };
    throw err;
  }
}
