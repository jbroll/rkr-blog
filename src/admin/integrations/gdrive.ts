// Google Drive picker integration. Loads gapi + picker SDKs lazily,
// exchanges a per-user access token, and imports each picked file via
// POST /admin/import/gdrive (which streams Drive bytes through the
// same ingestStream as a direct upload).
//
// The Drive route uses the drive.file scope, so only files the user
// creates or opens via the picker are reachable. Tokens and picker
// config arrive from per-user OAuth state stored in oauth_tokens.

import type { Editor } from '@tiptap/core';

import { setStatus } from '../dom';
import type { UploadResponse } from '../upload';

interface GdriveStatus {
  connected: boolean;
}

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
}
interface PickerInstance {
  setVisible(visible: boolean): void;
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
    DocsView: new (viewId?: unknown) => unknown;
    ViewId: { DOCS_IMAGES: unknown };
    Action: { PICKED: string };
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

async function gdriveStatus(): Promise<GdriveStatus> {
  const res = await fetch('/admin/integrations/gdrive/status');
  if (!res.ok) throw new Error(`status: ${res.status}`);
  return (await res.json()) as GdriveStatus;
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

async function importGdriveFile(fileId: string): Promise<UploadResponse> {
  const res = await fetch('/admin/import/gdrive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadResponse;
}

/**
 * Open Drive picker → on selection, import each chosen file and insert as
 * an image node in the editor. Resolves after every file has been imported.
 */
export async function pickFromDrive(editor: Editor): Promise<void> {
  const status = await gdriveStatus();
  if (!status.connected) {
    if (confirm('Google Drive is not connected for your account. Open the connect flow now?')) {
      window.location.href = '/admin/integrations/gdrive/connect';
    }
    return;
  }

  const [token, config, picker] = await Promise.all([
    gdriveAccessToken(),
    gdrivePickerConfig(),
    loadPicker()
  ]);

  const view = new picker.DocsView(picker.ViewId.DOCS_IMAGES);
  const instance = new picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(token.accessToken)
    .setDeveloperKey(config.developerKey)
    .setAppId(config.appId)
    .setCallback(async (data) => {
      if (data.action !== picker.Action.PICKED) return;
      const docs = data.docs ?? [];
      for (const doc of docs) {
        setStatus(`importing ${doc.name ?? doc.id} from Drive…`);
        try {
          const r = await importGdriveFile(doc.id);
          editor
            .chain()
            .focus()
            .insertContent({ type: 'figure', attrs: { ids: r.id } })
            .run();
          setStatus(`imported ${doc.name ?? doc.id} (${r.bytes} bytes)`);
        } catch (err) {
          setStatus(`Drive import error: ${(err as Error).message}`);
        }
      }
    })
    .build();
  instance.setVisible(true);
}
