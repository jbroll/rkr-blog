// OPFS schema versioning + migration framework. Reads / initializes
// opfs://meta/_root.json, refuses downgrades, runs forward migrations
// when the on-disk schema is older than OPFS_SCHEMA_CURRENT.
//
// Per spec-offline.md §10:
//   • _root.json#schemaVersion is the layout version.
//   • Forward migrations are atomic: write results into
//     opfs://_migration-<from>-<to>/, then atomically rename
//     _root.json.tmp → _root.json. The version bump is the commit
//     point. A crash before it leaves the old layout intact + a
//     leftover migration tree the next run cleans up.
//   • Downgrades (newer browser cache, older deployed code) refuse
//     to load OPFS rather than corrupt; the SPA surfaces a "browser
//     cache is from a newer version" error and offers reset.
//
// Phase 1 (this commit): the framework is in place but the
// MIGRATIONS table is empty — v1 is the initial schema, nothing to
// migrate FROM. The first real migration (v1 → v2) would add an
// entry here when a future phase changes a JSON shape or a
// directory layout.

import { isSupported, readJson, writeJson } from './opfs.ts';

/** Bump alongside any schema-affecting change to the OPFS layout
 * (a meta/*.json shape change, a new directory eviction must know
 * about, etc.). Pure additions of optional fields don't need a
 * bump. See spec-offline.md §10 for the migration playbook. */
const OPFS_SCHEMA_CURRENT = 1 as const;

const ROOT_PATH = 'meta/_root.json';

interface OpfsRoot {
  schemaVersion: number;
  /** Stable per-device id, generated on first OPFS write. Useful
   * for multi-device debug ("which device drained this outbox
   * entry?") — sent in outbox JSON's `deviceId` field. */
  deviceId: string;
}

export type SchemaStatus =
  | { status: 'unsupported' } /* Browser lacks OPFS; offline mode disabled. */
  | { status: 'fresh' } /* OPFS was empty; we initialized at CURRENT. */
  | { status: 'current' } /* On-disk version === CURRENT. No-op. */
  | { status: 'migrated'; from: number; to: number }
  | { status: 'downgrade'; onDisk: number; current: number };

type Migration = (root: OpfsRoot) => Promise<OpfsRoot>;

/** Ordered list of forward migrations. Each key is "from→to". When
 * adding a new schema version, append the entry here AND bump
 * OPFS_SCHEMA_CURRENT in the same commit so the runner picks it
 * up. */
const MIGRATIONS: Map<string, Migration> = new Map();

function makeRoot(): OpfsRoot {
  return {
    schemaVersion: OPFS_SCHEMA_CURRENT,
    deviceId: makeDeviceId()
  };
}

function makeDeviceId(): string {
  // Crypto.randomUUID is universal in OPFS-supporting browsers (it
  // shipped before OPFS).
  return crypto.randomUUID();
}

/** Read on-disk schema state, run any pending forward migrations,
 * write the new _root.json. Always called once at admin SPA mount,
 * before any other OPFS code runs. Returns a status the caller
 * uses to decide what to surface in the UI. */
export async function ensureSchema(): Promise<SchemaStatus> {
  /* v8 ignore next 3 -- offline-mode-disabled path on pre-OPFS browsers */
  if (!isSupported()) {
    return { status: 'unsupported' };
  }
  const onDisk = await readJson<OpfsRoot>(ROOT_PATH);
  if (!onDisk) {
    await writeJson(ROOT_PATH, makeRoot());
    return { status: 'fresh' };
  }

  const fromVersion = onDisk.schemaVersion;
  if (fromVersion === OPFS_SCHEMA_CURRENT) {
    return { status: 'current' };
  }
  /* v8 ignore start -- v1-unreachable: no v2 schema exists yet, so
     the downgrade + migration paths are scaffolding that activates
     when a future schema bump lands. Markers come off then. */
  if (fromVersion > OPFS_SCHEMA_CURRENT) {
    return { status: 'downgrade', onDisk: fromVersion, current: OPFS_SCHEMA_CURRENT };
  }

  let working = onDisk;
  for (let v = fromVersion; v < OPFS_SCHEMA_CURRENT; v++) {
    const key = `${v}->${v + 1}`;
    const step = MIGRATIONS.get(key);
    if (!step) {
      throw new Error(`opfs-schema: missing migration ${key}`);
    }
    working = await step(working);
    working.schemaVersion = v + 1;
  }
  await writeJson(ROOT_PATH, working);
  return { status: 'migrated', from: fromVersion, to: OPFS_SCHEMA_CURRENT };
  /* v8 ignore stop */
}
