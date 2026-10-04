// The athlete's data for one request. APEX is local-first and has no server copy: the device sends
// its own data with the request, it is checked exactly like data read from device storage, frozen,
// used for this request only, and never stored. Tools read it; nothing can write to it.
import { loadData, memoryStore, writeAll } from '../../src/data/store';
import type { ApexData } from '../../src/domain/types';
import { hydrate } from '../../src/services/apex';
import type { AuthUser } from './security';

export interface AthleteDataSource {
  /** Data for this authenticated user only. null = nothing usable was provided. */
  load(user: AuthUser, snapshot: Record<string, unknown> | undefined, now: Date): Promise<Readonly<ApexData> | null>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

/**
 * The request's own snapshot. A collection that fails the app's storage checks makes the whole
 * snapshot unusable rather than silently answering from defaults.
 * ponytail: the caller's data travels with each request; with cloud sync, a source that loads by user id replaces this.
 */
export const snapshotSource: AthleteDataSource = {
  async load(_user, snapshot, now) {
    if (!isObject(snapshot)) return null;
    const instances = Array.isArray(snapshot.instances) ? snapshot.instances.filter((i) => isObject(i) && typeof i.id === 'string') : [];
    const store = memoryStore();
    await writeAll(store, { ...snapshot, instances } as unknown as ApexData);
    const { data, recovered } = await loadData(store);
    if (recovered.length) return null;
    return deepFreeze(hydrate(data, now).data);
  },
};
