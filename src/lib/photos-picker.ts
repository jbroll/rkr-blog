// Thin wrapper over the Google Photos Picker API (photospicker.
// googleapis.com). Flow: create a picking session → the user selects
// items in Google's picker UI → poll until mediaItemsSet → list the
// picked items (baseUrl downloads) → delete the session. The Library
// API cannot do this: since 2025-04 it returns app-created items only.

import { assertSafeFetchUrl } from './url-safety.ts';

const PICKER_BASE = 'https://photospicker.googleapis.com/v1';

/** OAuth scope for picking sessions. Same Google client as Drive. */
export const PHOTOS_PICKER_SCOPE =
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

export interface PickedItem {
  id: string;
  name: string;
  mimeType: string;
  thumbnailUrl: string;
  /** Server-side only — never sent to the browser (like a refresh token). */
  downloadUrl: string;
  kind: 'image' | 'video';
}

interface FetcherOpts {
  fetcher?: typeof fetch;
}

async function authed(
  url: string,
  accessToken: string,
  opts: FetcherOpts,
  init?: RequestInit
): Promise<Response> {
  const fetchImpl = opts.fetcher ?? fetch;
  // All hosts here are module constants, so there is no SSRF surface;
  // still validate the production path. Stubs skip the DNS lookup so
  // unit tests stay hermetic (same convention as the Drive/Graph twins,
  // whose bypass keys on their own constant host).
  /* c8 ignore next -- production fetch hits the network; stubs bypass it */
  const target = opts.fetcher ? url : (await assertSafeFetchUrl(url)).toString();
  return fetchImpl(target, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${accessToken}` }
  });
}

/** Parse a protobuf-style duration ('5s', '600s') to milliseconds. */
function durationMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === 'string') {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(raw.trim());
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  return fallbackMs;
}

export interface PickingSession {
  sessionId: string;
  pickerUri: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Create a picking session. Returns the session id, the pickerUri to
 * open for the user, and the server-recommended polling cadence.
 */
export async function createPickingSession(
  accessToken: string,
  opts: FetcherOpts = {}
): Promise<PickingSession> {
  const res = await authed(`${PICKER_BASE}/sessions`, accessToken, opts, { method: 'POST' });
  if (!res.ok) throw new Error(`photos create: HTTP ${res.status}`);
  const data = (await res.json()) as {
    id?: string;
    pickerUri?: string;
    pollingConfig?: { pollInterval?: string; timeoutIn?: string };
  };
  if (!data.id || !data.pickerUri) throw new Error('photos create: missing id or pickerUri');
  return {
    sessionId: data.id,
    pickerUri: data.pickerUri,
    pollIntervalMs: durationMs(data.pollingConfig?.pollInterval, 5000),
    timeoutMs: durationMs(data.pollingConfig?.timeoutIn, 600000)
  };
}

/** Poll a session. `done` is true once the user finished selecting. */
export async function getPickingSession(
  accessToken: string,
  sessionId: string,
  opts: FetcherOpts = {}
): Promise<{ done: boolean }> {
  const res = await authed(
    `${PICKER_BASE}/sessions/${encodeURIComponent(sessionId)}`,
    accessToken,
    opts
  );
  if (!res.ok) throw new Error(`photos poll: HTTP ${res.status}`);
  const data = (await res.json()) as { mediaItemsSet?: boolean };
  return { done: data.mediaItemsSet === true };
}

/**
 * List the items the user picked in a completed session. Only
 * photo/video kinds are surfaced; anything else is dropped.
 */
export async function listSessionMediaItems(
  accessToken: string,
  sessionId: string,
  opts: FetcherOpts & { pageToken?: string } = {}
): Promise<{ items: PickedItem[]; nextPageToken: string | null }> {
  const url = new URL(`${PICKER_BASE}/mediaItems`);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('pageSize', '100');
  if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken);
  const res = await authed(url.toString(), accessToken, opts);
  if (!res.ok) throw new Error(`photos list: HTTP ${res.status}`);
  const data = (await res.json()) as {
    mediaItems?: Array<{
      id?: string;
      mediaFile?: {
        baseUrl?: string;
        filename?: string;
        mimeType?: string;
        mediaFileMetadata?: { video?: object };
      };
    }>;
    nextPageToken?: string;
  };
  const items: PickedItem[] = [];
  for (const raw of data.mediaItems ?? []) {
    const file = raw.mediaFile;
    if (!raw.id || !file?.baseUrl || !file.filename || !file.mimeType) continue;
    const kind = file.mimeType.startsWith('video/')
      ? 'video'
      : file.mimeType.startsWith('image/')
        ? 'image'
        : null;
    if (!kind) continue;
    items.push({
      id: raw.id,
      name: file.filename,
      mimeType: file.mimeType,
      thumbnailUrl: `${file.baseUrl}=w256-h256`,
      downloadUrl: `${file.baseUrl}=d`,
      kind
    });
  }
  return { items, nextPageToken: data.nextPageToken ?? null };
}

/** Delete a session. A missing (expired/consumed) session is not an error. */
export async function deletePickingSession(
  accessToken: string,
  sessionId: string,
  opts: FetcherOpts = {}
): Promise<void> {
  const res = await authed(
    `${PICKER_BASE}/sessions/${encodeURIComponent(sessionId)}`,
    accessToken,
    opts,
    { method: 'DELETE' }
  );
  if (res.ok || res.status === 404) return;
  throw new Error(`photos delete: HTTP ${res.status}`);
}
