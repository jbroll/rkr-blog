// Shared helpers for cloud storage provider integrations (gdrive, onedrive).

import type { UploadResponse } from '../upload.ts';

/**
 * Fetch the provider's /status endpoint and redirect to its connect flow
 * if not connected. Returns true if connected and the caller should proceed,
 * false if the user was prompted and the caller should bail.
 */
export async function ensureConnected(
  label: string,
  statusUrl: string,
  connectUrl: string
): Promise<boolean> {
  const res = await fetch(statusUrl);
  if (!res.ok) throw new Error(`status: ${res.status}`);
  const { connected } = (await res.json()) as { connected: boolean };
  if (!connected) {
    if (confirm(`${label} is not connected for your account. Open the connect flow now?`)) {
      window.location.href = connectUrl;
    }
    return false;
  }
  return true;
}

/** POST a fileId to a provider import endpoint and return the UploadResponse. */
export async function importCloudFile(importUrl: string, fileId: string): Promise<UploadResponse> {
  const res = await fetch(importUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadResponse;
}
