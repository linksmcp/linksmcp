import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Range {
  min: number;
  max: number;
}

export interface Config {
  /** Daily caps, counted per local calendar day in `timezone`. */
  caps: {
    messages: number;
    new_threads: number;
    invitations: number;
    profile_views: number;
    searches: number;
    accepts: number;
  };
  /** Writes happen only inside this local window, every day. "HH:MM". */
  working_hours: { start: string; end: string };
  /** Random gap between any two writes, in seconds. */
  write_gap_seconds: Range;
  /** Random gap between two connection requests, in seconds. */
  invite_gap_seconds: Range;
  /** Minimum hours between two messages to one person while your message is the last one in the thread. */
  follow_up_floor_hours: number;
  /** Hours writes stay paused after a security check or a restriction. */
  restriction_pause_hours: number;
  /** IANA time zone used for days and working hours. Empty = this machine's. */
  timezone: string;
  /** Override for LinkedIn's people search query id, which LinkedIn changes from time to time. */
  search_query_id: string;
}

export const DEFAULT_SEARCH_QUERY_ID = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';

export const DEFAULT_CONFIG: Config = {
  caps: { messages: 100, new_threads: 50, invitations: 20, profile_views: 250, searches: 30, accepts: 20 },
  working_hours: { start: '08:00', end: '20:00' },
  write_gap_seconds: { min: 20, max: 60 },
  invite_gap_seconds: { min: 300, max: 480 },
  follow_up_floor_hours: 24,
  restriction_pause_hours: 48,
  timezone: '',
  search_query_id: DEFAULT_SEARCH_QUERY_ID,
};

export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-4]):([0-5]\d)$/;

function int(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function range(v: unknown, fallback: Range): Range {
  if (typeof v === 'number' && v >= 0) return { min: v, max: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const min = typeof o.min === 'number' && o.min >= 0 ? o.min : fallback.min;
    const max = typeof o.max === 'number' && o.max >= min ? o.max : Math.max(min, fallback.max);
    return { min, max };
  }
  return { ...fallback };
}

function hours(v: unknown, fallback: { start: string; end: string }): { start: string; end: string } {
  if (typeof v === 'string') {
    const [s, e] = v.split('-').map((x) => x.trim());
    if (s && e && HHMM.test(s) && HHMM.test(e)) return { start: s, end: e };
    return { ...fallback };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const start = typeof o.start === 'string' && HHMM.test(o.start) ? o.start : fallback.start;
    const end = typeof o.end === 'string' && HHMM.test(o.end) ? o.end : fallback.end;
    return { start, end };
  }
  return { ...fallback };
}

/** Normalises parsed config.json plus env overrides into a valid Config. Bad values keep the default. */
export function normaliseConfig(raw: unknown, env: NodeJS.ProcessEnv = {}): Config {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const c = (o.caps && typeof o.caps === 'object' ? o.caps : {}) as Record<string, unknown>;
  const d = DEFAULT_CONFIG;
  const cfg: Config = {
    caps: {
      messages: int(env.LINKSMCP_MESSAGES_PER_DAY ?? c.messages, d.caps.messages),
      new_threads: int(env.LINKSMCP_NEW_THREADS_PER_DAY ?? c.new_threads, d.caps.new_threads),
      invitations: int(env.LINKSMCP_INVITES_PER_DAY ?? c.invitations, d.caps.invitations),
      profile_views: int(env.LINKSMCP_PROFILE_VIEWS_PER_DAY ?? c.profile_views, d.caps.profile_views),
      searches: int(env.LINKSMCP_SEARCHES_PER_DAY ?? c.searches, d.caps.searches),
      accepts: int(env.LINKSMCP_ACCEPTS_PER_DAY ?? c.accepts, d.caps.accepts),
    },
    working_hours: hours(env.LINKSMCP_WORKING_HOURS ?? o.working_hours, d.working_hours),
    write_gap_seconds: range(o.write_gap_seconds, d.write_gap_seconds),
    invite_gap_seconds: range(o.invite_gap_seconds, d.invite_gap_seconds),
    follow_up_floor_hours: int(o.follow_up_floor_hours, d.follow_up_floor_hours),
    restriction_pause_hours: int(o.restriction_pause_hours, d.restriction_pause_hours),
    timezone: '',
    search_query_id: d.search_query_id,
  };
  const tz = (env.LINKSMCP_TZ ?? (typeof o.timezone === 'string' ? o.timezone : '')).trim();
  cfg.timezone = tz && validTimeZone(tz) ? tz : machineTimeZone();
  const q = (env.LINKSMCP_SEARCH_QUERY_ID ?? (typeof o.search_query_id === 'string' ? o.search_query_id : '')).trim();
  if (q) cfg.search_query_id = q;
  return cfg;
}

/** Reads config.json (writing the defaults first if it does not exist) and applies env overrides. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  if (!existsSync(path)) {
    const { timezone: _tz, ...rest } = DEFAULT_CONFIG;
    writeFileSync(path, JSON.stringify({ ...rest, timezone: '' }, null, 2) + '\n', { mode: 0o600 });
    return normaliseConfig({}, env);
  }
  try {
    return normaliseConfig(JSON.parse(readFileSync(path, 'utf8')), env);
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}
