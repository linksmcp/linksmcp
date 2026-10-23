/**
 * LinkedIn answers in two shapes: plain nested JSON, or "normalized" JSON where nested objects
 * are moved into a top-level `included` array and referenced by URN under a `*field` key.
 * These helpers read either shape, and every parser below tolerates missing fields.
 */

export type Obj = Record<string, any>;

export class Graph {
  private byUrn = new Map<string, Obj>();
  readonly root: Obj;
  readonly included: Obj[];

  constructor(json: unknown) {
    const j = (json && typeof json === 'object' ? json : {}) as Obj;
    this.included = Array.isArray(j.included) ? j.included.filter((x: unknown) => x && typeof x === 'object') : [];
    for (const o of this.included) if (typeof o.entityUrn === 'string') this.byUrn.set(o.entityUrn, o);
    this.root = j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : j;
  }

  lookup(urn: unknown): Obj | undefined {
    return typeof urn === 'string' ? this.byUrn.get(urn) : undefined;
  }

  /** obj[key], or the included object(s) obj['*' + key] points at. */
  get(obj: Obj | undefined, key: string): any {
    if (!obj) return undefined;
    if (obj[key] !== undefined) return obj[key];
    const ref = obj[`*${key}`];
    if (Array.isArray(ref)) return ref.map((u) => this.lookup(u)).filter(Boolean);
    return this.lookup(ref);
  }

  /** The root collection: root.elements, root['*elements'], or the plain top-level elements. */
  elements(): Obj[] {
    const e = this.get(this.root, 'elements');
    return Array.isArray(e) ? e.filter((x) => x && typeof x === 'object') : [];
  }

  /** Included objects whose $type (or _type) ends with the given suffix. */
  ofType(suffix: string): Obj[] {
    return this.included.filter((o) => typeType(o).endsWith(suffix));
  }
}

export function typeType(o: Obj): string {
  return String(o.$type ?? o._type ?? '');
}

/** Unwraps a rest.li union such as {"com.linkedin.voyager.messaging.MessagingMember": {...}}. */
export function unwrap(v: any): Obj | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0].startsWith('com.linkedin.')) return v[keys[0]];
  return v;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The last segment of a URN: urn:li:fs_miniProfile:ACoAA... -> ACoAA... */
export function urnId(urn: unknown): string | undefined {
  if (typeof urn !== 'string') return undefined;
  const m = /^urn:li:[^:]+:(.+)$/.exec(urn);
  return m ? m[1] : undefined;
}

/** A text field that may be a string or {text}. */
export function textOf(v: any): string | undefined {
  if (typeof v === 'string') return str(v);
  if (v && typeof v === 'object' && typeof v.text === 'string') return str(v.text);
  return undefined;
}

export function fullName(first: unknown, last: unknown): string | undefined {
  const n = [str(first), str(last)].filter(Boolean).join(' ').trim();
  return n || undefined;
}
