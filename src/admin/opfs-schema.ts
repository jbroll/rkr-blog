// OPFS schema versioning + migration framework (spec-offline §10).

import { isSupported, readJson, writeJson } from './opfs.ts';

/** Bump alongside any schema-affecting change. Pure additions of
 * optional fields don't need a bump — see spec-offline §10 for the
 * migration playbook. */
const OPFS_SCHEMA_CURRENT = 1 as const;

const ROOT_PATH = 'meta/_root.json';

/** @public */
export interface OpfsRoot {
  schemaVersion: number;
  deviceId: string;
  /** Monotonic outbox-seq counter. Defaults to 0 when missing. */
  nextSeq?: number;
  /** Active draft id (single-draft session model). */
  currentDraftId?: string;
}

export type SchemaStatus =
  | { status: 'unsupported' }
  | { status: 'fresh' }
  | { status: 'current' }
  | { status: 'migrated'; from: number; to: number }
  | { status: 'downgrade'; onDisk: number; current: number };

type Migration = (root: OpfsRoot) => Promise<OpfsRoot>;

/** Forward migrations keyed "from->to". Bump OPFS_SCHEMA_CURRENT in
 * the same commit that adds an entry. */
const MIGRATIONS: Map<string, Migration> = new Map();

function makeRoot(): OpfsRoot {
  return {
    schemaVersion: OPFS_SCHEMA_CURRENT,
    deviceId: makeDeviceId(),
    nextSeq: 0
  };
}

export async function readRoot(): Promise<OpfsRoot | null> {
  return readJson<OpfsRoot>(ROOT_PATH);
}

export async function writeRoot(root: OpfsRoot): Promise<void> {
  await writeJson(ROOT_PATH, root);
}

function makeDeviceId(): string {
  return crypto.randomUUID();
}

export async function ensureSchema(): Promise<SchemaStatus> {
  /* v8 ignore next 3 -- pre-OPFS browser */
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
  /* v8 ignore start -- v1-unreachable: no v2 schema yet */
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
