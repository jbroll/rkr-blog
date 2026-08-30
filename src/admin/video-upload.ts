// Video upload via POST /admin/upload/video. Direct server ingest
// (no client resize/OPFS) — the server probes and stores the master.

export interface VideoUploadResponse {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
  videoUrl: string;
  posterUrl: string;
}

export async function uploadVideo(file: File): Promise<VideoUploadResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/admin/upload/video', {
    method: 'POST',
    body: form,
    credentials: 'same-origin'
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `video upload failed (${res.status})`);
  }
  return (await res.json()) as VideoUploadResponse;
}
