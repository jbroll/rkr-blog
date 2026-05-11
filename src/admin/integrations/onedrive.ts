// MVP OneDrive insert flow — connect-status check + manual id prompt.
// Replace with the Microsoft File Picker SDK once the deployment has
// an MS Entra app registered (the picker-config endpoint is ready;
// only the JS SDK integration is missing).
//
// See DEFERRED.md for the picker-SDK upgrade entry.

import { setStatus } from '../dom';
import type { UploadResponse } from '../upload';

interface OneDriveStatus {
  connected: boolean;
}

async function oneDriveStatus(): Promise<OneDriveStatus> {
  const res = await fetch('/admin/integrations/onedrive/status');
  if (!res.ok) throw new Error(`status: ${res.status}`);
  return (await res.json()) as OneDriveStatus;
}

async function importOneDriveFile(fileId: string): Promise<UploadResponse> {
  const res = await fetch('/admin/import/onedrive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadResponse;
}

/** Extract a OneDrive item id from a raw id, a share link, or a Graph
 * URL. Falls back to the input verbatim if it already looks like an id
 * (alphanumeric + a few separators). Returns null on garbage. */
function parseOneDriveId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /\/items\/([A-Za-z0-9!_-]+)/.exec(trimmed);
  if (m) return m[1] ?? null;
  if (/^[A-Za-z0-9!_-]+$/.test(trimmed)) return trimmed;
  return null;
}

/** Prompt for a OneDrive item id, import it, and return the resulting
 * stored image id (or [] if the user cancelled / parse failed). The
 * caller decides how to insert into the editor — a fresh figure for
 * +Image, or appended to an existing figure for in-figure +. */
export async function pickFromOneDrive(): Promise<string[]> {
  const status = await oneDriveStatus();
  if (!status.connected) {
    if (confirm('OneDrive is not connected for your account. Open the connect flow now?')) {
      window.location.href = '/admin/integrations/onedrive/connect';
    }
    return [];
  }
  const input = prompt('OneDrive item id (or share link):', '');
  if (!input) return [];
  const fileId = parseOneDriveId(input);
  if (!fileId) {
    setStatus('OneDrive: could not extract an item id from input');
    return [];
  }
  setStatus(`importing ${fileId.slice(0, 12)}… from OneDrive`);
  try {
    const r = await importOneDriveFile(fileId);
    setStatus(`imported from OneDrive (${r.bytes} bytes${r.deduplicated ? ', dedup' : ''})`);
    return [r.id];
  } catch (err) {
    setStatus(`OneDrive import error: ${(err as Error).message}`);
    return [];
  }
}
