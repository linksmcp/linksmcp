import type { LinkedInClient } from './client.js';
import { Graph, textOf, typeType, type Obj } from './normalize.js';
import { restli, usernameFromUrl } from './ids.js';
import { profileUrlFor } from '../wire.js';

export interface PersonHit {
  linkedin_username: string;
  profile_url: string;
  name: string | null;
  headline: string | null;
  location: string | null;
}

export interface SearchInput {
  keywords: string;
  location?: string;
  current_company?: string;
  start?: number;
}

/** LinkedIn returns this many people per search page. */
export const SEARCH_PAGE_SIZE = 10;

/**
 * Builds the graphql path for a people search. location and current_company accept LinkedIn's
 * numeric ids (geo id, company id) as filters; any other text is added to the keywords.
 */
export function buildSearchQuery(input: SearchInput, queryId: string): string {
  const words = [input.keywords];
  const filters = ['(key:resultType,value:List(PEOPLE))'];
  const loc = input.location?.trim();
  const co = input.current_company?.trim();
  if (loc) {
    if (/^\d+$/.test(loc)) filters.push(`(key:geoUrn,value:List(${loc}))`);
    else words.push(loc);
  }
  if (co) {
    if (/^\d+$/.test(co)) filters.push(`(key:currentCompany,value:List(${co}))`);
    else words.push(co);
  }
  const keywords = restli(words.join(' ').replace(/\s+/g, ' ').trim());
  const start = Math.max(0, Math.floor(input.start ?? 0));
  const variables =
    `(start:${start},origin:GLOBAL_SEARCH_HEADER,query:(keywords:${keywords},flagshipSearchIntent:SEARCH_SRP,` +
    `queryParameters:List(${filters.join(',')}),includeFiltersInResponse:false))`;
  return `variables=${variables}&queryId=${queryId}&includeWebMetadata=true`;
}

function nestedResults(root: Obj): Obj[] {
  const clusters = root?.searchDashClustersByAll;
  const out: Obj[] = [];
  for (const cl of Array.isArray(clusters?.elements) ? clusters.elements : []) {
    for (const it of Array.isArray(cl?.items) ? cl.items : []) {
      const e = it?.item?.entityResult;
      if (e && typeof e === 'object') out.push(e);
    }
  }
  return out;
}

/** Parses a people search answer, in either response shape. Skips private members without a public profile. */
export function parseSearch(json: unknown): PersonHit[] {
  const g = new Graph(json);
  let results = g.included.filter((o) => typeType(o).endsWith('EntityResultViewModel'));
  if (!results.length) results = nestedResults(g.root);
  const seen = new Set<string>();
  const people: PersonHit[] = [];
  for (const r of results) {
    const nav = typeof r.navigationUrl === 'string' ? r.navigationUrl.split('?')[0] : '';
    const username = nav ? usernameFromUrl(nav) : null;
    if (!username || seen.has(username)) continue;
    seen.add(username);
    people.push({
      linkedin_username: username,
      profile_url: profileUrlFor(username),
      name: textOf(r.title) ?? null,
      headline: textOf(r.primarySubtitle) ?? null,
      location: textOf(r.secondarySubtitle) ?? null,
    });
  }
  return people;
}

/**
 * One search request (one search on the daily count). Returns at most `limit` people and,
 * when LinkedIn returned a full page, the `start` for the next page.
 */
export async function searchPeople(
  c: LinkedInClient,
  input: SearchInput & { limit: number },
  queryId: string,
): Promise<{ people: PersonHit[]; next_start?: number }> {
  const json = await c.request('/graphql', { query: buildSearchQuery(input, queryId) });
  const all = parseSearch(json);
  const people = all.slice(0, input.limit);
  const start = Math.max(0, Math.floor(input.start ?? 0));
  const out: { people: PersonHit[]; next_start?: number } = { people };
  if (all.length >= SEARCH_PAGE_SIZE || all.length > people.length) out.next_start = start + people.length;
  return out;
}
