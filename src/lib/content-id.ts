// Content-addressed image id (sha256 hex). Must match the server
// digest in src/lib/originals.ts:ingestStream so client-computed
// ids round-trip across the offline drain.

export async function computeContentId(input: Blob): Promise<string> {
  const buf = await input.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// MIME → extension for opfs://originals/<id>.<ext>. The server
// normalizes via sharp.metadata; the client's choice only sticks
// until the outbox drain replaces it.
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heic'
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
}
