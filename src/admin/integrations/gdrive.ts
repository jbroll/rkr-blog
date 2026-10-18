// Google Drive picker integration. Loads gapi + picker SDKs lazily,
// exchanges a per-user access token, and imports each picked file via
// POST /admin/import/gdrive (or /admin/import/gdrive/video for the video
// picker, which streams Drive bytes through the video ingest path).
//
// The Drive route uses the drive.file scope, so only files the user
// creates or opens via the picker are reachable. Tokens and picker
// config arrive from per-user OAuth state stored in oauth_tokens.

import { setStatus } from '../dom';
import { ensureConnected, importCloudFile, importCloudVideo } from './provider-helpers.ts';

interface GdriveAccessToken {
  accessToken: string;
  expiresAt: string;
}

interface GdrivePickerConfig {
  clientId: string;
  developerKey: string;
  appId: string;
}

// Minimal type shims for the Google Picker / gapi globals. Loaded
// dynamically at runtime; we don't ship @types/google.picker because
// the imports here are intentionally narrow.
interface PickerDoc {
  id: string;
  name?: string;
  mimeType?: string;
}
interface PickerResponseShape {
  action: string;
  docs?: PickerDoc[];
  message?: string;
}
interface PickerInstance {
  setVisible(visible: boolean): void;
}
interface DocsViewInstance {
  setMimeTypes(mimeTypes: string): DocsViewInstance;
}
interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(cb: (data: PickerResponseShape) => void): PickerBuilder;
  build(): PickerInstance;
}
interface GoogleGlobal {
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => DocsViewInstance;
    ViewId: { DOCS: unknown; DOCS_IMAGES: unknown; DOCS_VIDEOS?: unknown };
    Action: { PICKED: string; CANCEL: string; ERROR: string };
  };
}
interface GapiGlobal {
  load(name: string, callback: () => void): void;
}

const GAPI_SRC = 'https://apis.google.com/js/api.js';

let gapiLoading: Promise<GapiGlobal> | null = null;
let pickerLoading: Promise<GoogleGlobal['picker']> | null = null;

function loadGapi(): Promise<GapiGlobal> {
  if (gapiLoading) return gapiLoading;
  gapiLoading = new Promise<GapiGlobal>((resolve, reject) => {
    const w = window as unknown as { gapi?: GapiGlobal };
    if (w.gapi) {
      resolve(w.gapi);
      return;
    }
    const script = document.createElement('script');
    script.src = GAPI_SRC;
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { gapi?: GapiGlobal }).gapi;
      if (loaded) resolve(loaded);
      else reject(new Error('gapi global missing after script load'));
    };
    script.onerror = () => reject(new Error('failed to load gapi script'));
    document.head.appendChild(script);
  });
  return gapiLoading;
}

async function loadPicker(): Promise<GoogleGlobal['picker']> {
  if (pickerLoading) return pickerLoading;
  pickerLoading = (async () => {
    const gapi = await loadGapi();
    await new Promise<void>((resolve) => gapi.load('picker', () => resolve()));
    const google = (window as unknown as { google?: GoogleGlobal }).google;
    if (!google) throw new Error('google global missing after picker load');
    return google.picker;
  })();
  return pickerLoading;
}

async function gdriveAccessToken(): Promise<GdriveAccessToken> {
  const res = await fetch('/admin/integrations/gdrive/access-token');
  if (!res.ok) throw new Error(`access-token: ${res.status}`);
  return (await res.json()) as GdriveAccessToken;
}

async function gdrivePickerConfig(): Promise<GdrivePickerConfig> {
  const res = await fetch('/admin/integrations/gdrive/picker-config');
  if (!res.ok) throw new Error(`picker-config: ${res.status}`);
  return (await res.json()) as GdrivePickerConfig;
}

/**
 * Open the Drive picker with `makeView`'s view → on selection, import each
 * chosen file via `importFile` and resolve with the resulting stored ids.
 * Cancelled / no-pick resolves [] so callers can branch without a
 * try/catch. The caller decides how to insert into the editor (new figure
 * vs append, image vs video).
 */
async function pickFromDriveInternal(
  makeView: (picker: GoogleGlobal['picker']) => unknown,
  importFile: (fileId: string) => Promise<{ id: string; bytes: number }>
): Promise<string[]> {
  const connected = await ensureConnected(
    'Google Drive',
    '/admin/integrations/gdrive/status',
    '/admin/integrations/gdrive/connect'
  );
  if (!connected) return [];

  const [token, config, picker] = await Promise.all([
    gdriveAccessToken(),
    gdrivePickerConfig(),
    loadPicker()
  ]);

  // Picker is callback-driven; bridge to a Promise so the caller can
  // await ids. CANCEL / no-pick resolves an empty array.
  return new Promise<string[]>((resolve) => {
    const view = makeView(picker);
    let builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token.accessToken)
      .setAppId(config.appId);
    if (config.developerKey) builder = builder.setDeveloperKey(config.developerKey);
    const instance = builder
      .setCallback(async (data) => {
        if (data.action === picker.Action.CANCEL) {
          resolve([]);
          return;
        }
        if (data.action === picker.Action.ERROR) {
          setStatus(`Drive picker error: ${data.message ?? 'unknown error'}`, true);
          resolve([]);
          return;
        }
        if (data.action !== picker.Action.PICKED) return;
        const ids: string[] = [];
        for (const doc of data.docs ?? []) {
          setStatus(`importing ${doc.name ?? doc.id} from Drive…`);
          try {
            const r = await importFile(doc.id);
            ids.push(r.id);
            setStatus(`imported ${doc.name ?? doc.id} (${r.bytes} bytes)`);
          } catch (err) {
            setStatus(`Drive import error: ${(err as Error).message}`, true);
          }
        }
        resolve(ids);
      })
      .build();
    instance.setVisible(true);
  });
}

/** Open the Drive picker restricted to images and import each pick. */
export function pickFromDrive(): Promise<string[]> {
  return pickFromDriveInternal(
    (picker) => new picker.DocsView(picker.ViewId.DOCS_IMAGES),
    (fileId) => importCloudFile('/admin/import/gdrive', fileId)
  );
}

/**
 * Drive video variant of pickFromDrive: restricted to video files and
 * imported through the /video endpoint so the returned ids point at
 * stored video masters.
 *
 * @public — wired into the editor entry bundle by Task 3's +Video source
 * picker; knip can't trace the dynamic picker path.
 */
export function pickFromDriveVideo(): Promise<string[]> {
  return pickFromDriveInternal(driveVideoView, (fileId) =>
    importCloudVideo('/admin/import/gdrive/video', fileId)
  );
}

/** Prefer Picker's dedicated video view; fall back to a DocsView limited
 * to video mime types on SDK builds that don't expose DOCS_VIDEOS. */
function driveVideoView(picker: GoogleGlobal['picker']): unknown {
  if (picker.ViewId.DOCS_VIDEOS) {
    return new picker.DocsView(picker.ViewId.DOCS_VIDEOS);
  }
  return new picker.DocsView(picker.ViewId.DOCS).setMimeTypes('video/*');
}
