import type { LinkedInClient } from './client.js';
import { Graph, fullName, num, str, textOf, urnId, type Obj } from './normalize.js';
import { profileUrlFor } from '../wire.js';
import { restli } from './ids.js';

export interface Experience {
  title?: string;
  company?: string;
  location?: string;
  start?: string;
  end?: string;
  description?: string;
}

export interface Education {
  school?: string;
  degree?: string;
  field_of_study?: string;
  start?: string;
  end?: string;
}

export interface PersonProfile {
  linkedin_username: string;
  linkedin_url: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  about: string | null;
  experience: Experience[];
  education: Education[];
  /** Internal member id used by messaging and invitations. */
  urn_id: string | null;
}

export interface Me {
  linkedin_username: string | null;
  name: string | null;
  headline: string | null;
  urn_id: string | null;
  plain_id: string | null;
}

function ym(d: any): string | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const y = num(d.year);
  if (!y) return undefined;
  const m = num(d.month);
  return m ? `${y}-${String(m).padStart(2, '0')}` : String(y);
}

function period(o: Obj, g: Graph): { start?: string; end?: string } {
  const tp = g.get(o, 'timePeriod') ?? o.dateRange;
  if (!tp) return {};
  const out: { start?: string; end?: string } = {};
  const s = ym(tp.startDate ?? tp.start);
  const e = ym(tp.endDate ?? tp.end);
  if (s) out.start = s;
  if (e) out.end = e;
  return out;
}

function clean<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function listOf(g: Graph, viewKey: string, typeSuffix: string): Obj[] {
  const view = g.get(g.root, viewKey);
  const els = view ? g.get(view, 'elements') : undefined;
  if (Array.isArray(els)) return els;
  return g.ofType(typeSuffix);
}

/** Parses /identity/profiles/{id}/profileView. */
export function parseProfileView(json: unknown, requested: string): PersonProfile {
  const g = new Graph(json);
  const profile: Obj = g.get(g.root, 'profile') ?? g.ofType('.identity.profile.Profile')[0] ?? {};
  const mini: Obj = g.get(profile, 'miniProfile') ?? g.ofType('.MiniProfile')[0] ?? {};
  const username = str(mini.publicIdentifier) ?? requested;
  const experience = listOf(g, 'positionView', '.identity.profile.Position').map((p) =>
    clean<Experience>({
      title: str(p.title),
      company: str(p.companyName) ?? str(g.get(p, 'company')?.miniCompany?.name),
      location: str(p.locationName),
      ...period(p, g),
      description: str(p.description),
    }),
  );
  const education = listOf(g, 'educationView', '.identity.profile.Education').map((e) =>
    clean<Education>({
      school: str(e.schoolName) ?? str(g.get(e, 'school')?.schoolName),
      degree: str(e.degreeName),
      field_of_study: str(e.fieldOfStudy),
      ...period(e, g),
    }),
  );
  return {
    linkedin_username: username,
    linkedin_url: profileUrlFor(username),
    name: fullName(profile.firstName ?? mini.firstName, profile.lastName ?? mini.lastName) ?? null,
    headline: str(profile.headline) ?? str(mini.occupation) ?? null,
    location: str(profile.geoLocationName) ?? str(profile.locationName) ?? null,
    about: textOf(profile.summary) ?? null,
    experience,
    education,
    urn_id: urnId(mini.entityUrn) ?? urnId(profile.entityUrn) ?? null,
  };
}

/** Parses /me. */
export function parseMe(json: unknown): Me {
  const g = new Graph(json);
  const mini: Obj = g.get(g.root, 'miniProfile') ?? g.ofType('.MiniProfile')[0] ?? {};
  return {
    linkedin_username: str(mini.publicIdentifier) ?? null,
    name: fullName(mini.firstName, mini.lastName) ?? null,
    headline: str(mini.occupation) ?? null,
    urn_id: urnId(mini.entityUrn) ?? urnId(mini.dashEntityUrn) ?? null,
    plain_id: g.root.plainId !== undefined ? String(g.root.plainId) : null,
  };
}

/** 0 = you, 1 = first degree, 2 = second, 3 = third or out of network, null = unknown. */
export function parseDistance(json: unknown): number | null {
  const g = new Graph(json);
  const d = g.root.distance ?? (json as Obj | null)?.distance;
  const v = typeof d === 'string' ? d : d?.value;
  switch (v) {
    case 'SELF':
      return 0;
    case 'DISTANCE_1':
      return 1;
    case 'DISTANCE_2':
      return 2;
    case 'DISTANCE_3':
    case 'OUT_OF_NETWORK':
      return 3;
    default:
      return null;
  }
}

export async function getMe(c: LinkedInClient): Promise<Me> {
  return parseMe(await c.request('/me'));
}

export async function getProfile(c: LinkedInClient, username: string): Promise<PersonProfile> {
  return parseProfileView(await c.request(`/identity/profiles/${restli(username)}/profileView`), username);
}

export async function getDistance(c: LinkedInClient, username: string): Promise<number | null> {
  return parseDistance(await c.request(`/identity/profiles/${restli(username)}/networkinfo`));
}
