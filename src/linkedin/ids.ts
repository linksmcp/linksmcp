import { ToolError } from '../wire.js';

const PROFILE_URL = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)\/?(?:[?#].*)?$/i;
const USERNAME = /^[^\s/?#&]{2,100}$/;

/** Public id from a profile URL such as https://www.linkedin.com/in/jane-doe-123/. */
export function usernameFromUrl(url: string): string | null {
  const m = PROFILE_URL.exec(url.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Resolves {linkedin_username | profile_url} to a public id, or throws invalid_recipient. */
export function resolveUsername(input: { linkedin_username?: string; profile_url?: string }): string {
  const given = [input.linkedin_username, input.profile_url].filter((v) => typeof v === 'string' && v.trim() !== '');
  if (given.length !== 1) {
    throw new ToolError('invalid_recipient', 'Give exactly one of linkedin_username or profile_url.');
  }
  if (input.profile_url && input.profile_url.trim()) {
    const u = usernameFromUrl(input.profile_url);
    if (!u) throw new ToolError('invalid_recipient', 'profile_url must look like https://www.linkedin.com/in/<public-id>/.');
    return u;
  }
  const raw = (input.linkedin_username as string).trim().replace(/^@/, '');
  const fromUrl = usernameFromUrl(raw);
  if (fromUrl) return fromUrl;
  if (!USERNAME.test(raw)) throw new ToolError('invalid_recipient', `"${raw}" is not a LinkedIn public id. Use the part after /in/ in the profile URL.`);
  return raw;
}

/** rest.li 2.0 value encoding: URL encoding plus the characters rest.li reserves. */
export function restli(v: string): string {
  return encodeURIComponent(v).replace(/[()'!*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
