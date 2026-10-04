// Local-first persistence. Small collections are one JSON document each; workouts are one
// key per session plus an index, so logging a set rewrites a single small record instead of
// the whole history (and no value grows toward Android's ~2 MB per-entry limit).
// The KeyValueStore shape matches AsyncStorage, so a sync layer can wrap it later.
import type { ApexData, SessionInstance } from '../domain/types';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const DOCS = [
  'user', 'profile', 'settings', 'plan', 'templates', 'plyoTemplates', 'basketball', 'recovery', 'bodyMetrics', 'performance', 'records',
] as const satisfies readonly (keyof ApexData)[];
export type Doc = (typeof DOCS)[number];
export type Collection = Doc | 'instances';

const PREFIX = 'apex:v1:';
const docKey = (c: string) => PREFIX + c;
const instanceKey = (id: string) => `${PREFIX}instance:${id}`;
const INDEX = `${PREFIX}instance-index`;
const LEGACY_INSTANCES = `${PREFIX}instances`; // phase-1 layout: every session in one document

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { dump(): Record<string, string>; failWrites: boolean } {
  const m = new Map(Object.entries(initial));
  const s = {
    failWrites: false,
    async getItem(k: string) { return m.get(k) ?? null; },
    async setItem(k: string, v: string) {
      if (s.failWrites) throw new Error('disk full');
      m.set(k, v);
    },
    async removeItem(k: string) { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
  return s;
}

// ---------- shape checks: tolerate missing fields, reject what would crash the app ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasId = (v: unknown) => isObj(v) && typeof v.id === 'string';
const listOfIds = (v: unknown) => Array.isArray(v);

const VALID: Record<Doc, (v: unknown) => boolean> = {
  user: isObj,
  profile: isObj,
  settings: isObj,
  plan: (v) => isObj(v) && Array.isArray(v.days) && v.days.length === 7 && Array.isArray(v.rotations),
  templates: listOfIds,
  plyoTemplates: listOfIds,
  basketball: listOfIds,
  recovery: Array.isArray,
  bodyMetrics: listOfIds,
  performance: listOfIds,
  records: listOfIds,
};

export const validInstance = (v: unknown): v is SessionInstance =>
  hasId(v) && isObj(v) && Array.isArray(v.exercises) && isObj(v.decision) && typeof v.date === 'string' &&
  (v.exercises as unknown[]).every((e) => isObj(e) && (v.kind === 'gym' ? Array.isArray(e.sets) : Array.isArray(e.logs)));

function parse(raw: string | null): { ok: true; value: unknown } | { ok: false } | null {
  if (raw === null) return null;
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export interface Loaded {
  data: Partial<ApexData> | undefined; // undefined = first launch
  recovered: Collection[]; // collections that were unreadable and must be reset
  needsFullWrite: boolean; // legacy layout or repaired data: rewrite everything once
}

/** Reads everything. Unreadable data is backed up under a `corrupt:` key and reported, never thrown. */
export async function loadData(store: KeyValueStore): Promise<Loaded> {
  const out: Partial<ApexData> = {};
  const recovered: Collection[] = [];
  let found = false;
  const backup = (key: string, raw: string) => store.setItem(`${PREFIX}corrupt:${key}:${Date.now()}`, raw).catch(() => undefined);

  const raws = await Promise.all(DOCS.map((c) => store.getItem(docKey(c))));
  for (let i = 0; i < DOCS.length; i++) {
    const c = DOCS[i];
    const p = parse(raws[i]);
    if (p === null) continue;
    found = true;
    if (p.ok && VALID[c](p.value)) {
      const v = p.value;
      // drop individual malformed rows rather than the whole list
      (out as Record<string, unknown>)[c] = Array.isArray(v) && c !== 'recovery' ? v.filter(hasId) : v;
    } else {
      recovered.push(c);
      await backup(c, raws[i]!);
    }
  }

  // sessions: index + one key each; migrate the single-document phase-1 layout if present
  const index = parse(await store.getItem(INDEX));
  const legacy = parse(await store.getItem(LEGACY_INSTANCES));
  let instances: unknown[] = [];
  let migrated = false;
  if (index?.ok && Array.isArray(index.value)) {
    found = true;
    const ids = index.value.filter((x): x is string => typeof x === 'string');
    const rows = await Promise.all(ids.map((id) => store.getItem(instanceKey(id))));
    rows.forEach((raw, k) => {
      const p = parse(raw);
      if (p?.ok) instances.push(p.value);
      else if (p && !p.ok) void backup(`instance:${ids[k]}`, raw!);
    });
  } else if (legacy?.ok && Array.isArray(legacy.value)) {
    found = true;
    migrated = true;
    instances = legacy.value;
  } else if (index || legacy) {
    found = true;
    recovered.push('instances');
  }
  if (instances.length || index?.ok || legacy?.ok) {
    const valid = instances.filter(validInstance);
    if (valid.length !== instances.length && !recovered.includes('instances')) recovered.push('instances');
    out.instances = valid;
  }
  return { data: found ? out : undefined, recovered, needsFullWrite: migrated || recovered.length > 0 };
}

export async function writeDocs(store: KeyValueStore, data: ApexData, keys: readonly Doc[]) {
  await Promise.all(keys.map((c) => store.setItem(docKey(c), JSON.stringify(data[c]))));
}

/** Writes only sessions whose object identity changed (state updates are immutable). */
export async function writeInstances(store: KeyValueStore, next: SessionInstance[], prev: SessionInstance[] | null) {
  const prevById = new Map((prev ?? []).map((i) => [i.id, i]));
  const nextIds = new Set(next.map((i) => i.id));
  const changed = next.filter((i) => prevById.get(i.id) !== i);
  const removed = (prev ?? []).filter((i) => !nextIds.has(i.id));
  // records first, index last: a crash can orphan a record but never point at a missing one
  await Promise.all(changed.map((i) => store.setItem(instanceKey(i.id), JSON.stringify(i))));
  if (!prev || removed.length || next.some((i) => !prevById.has(i.id))) await store.setItem(INDEX, JSON.stringify(next.map((i) => i.id)));
  await Promise.all(removed.map((i) => store.removeItem(instanceKey(i.id))));
}

export async function writeAll(store: KeyValueStore, data: ApexData) {
  await writeDocs(store, data, DOCS);
  await writeInstances(store, data.instances, null);
  await store.removeItem(LEGACY_INSTANCES);
}

export async function clearData(store: KeyValueStore, data: ApexData) {
  await Promise.all([
    ...DOCS.map((c) => store.removeItem(docKey(c))),
    ...data.instances.map((i) => store.removeItem(instanceKey(i.id))),
    store.removeItem(INDEX),
    store.removeItem(LEGACY_INSTANCES),
  ]);
}
