// Wraps POST /admin/upload — the multipart endpoint that ingests a
// File into a sidecar + originals row and returns the canonical id.
// Used by the toolbar Image button, drag-drop, paste, and the Drive /
// OneDrive import flows (which fetch bytes server-side then invoke
// the same ingestStream as /admin/upload).

/** JSON returned by POST /admin/upload on success. */
export interface UploadResponse {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
}

export async function uploadImage(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/admin/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as UploadResponse;
}
