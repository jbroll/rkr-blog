// Admin routes. Authentication is added in Step 9 — for now these are open.

import { paths } from '../lib/config.js';
import { ingestStream } from '../lib/originals.js';

export default async function adminRoutes(fastify, opts) {
  const siteRoot = opts.siteRoot ?? paths().root;

  fastify.post('/admin/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no file part' });

    try {
      const result = await ingestStream({
        stream: part.file,
        siteRoot,
        source: { kind: 'upload', originalName: part.filename ?? null }
      });

      // @fastify/multipart sets file.truncated when the size limit was hit.
      if (part.file.truncated) {
        return reply.code(413).send({ error: 'file too large' });
      }

      return {
        id: result.id,
        bytes: result.bytes,
        deduplicated: result.deduplicated,
        ext: result.ext
      };
    } catch (err) {
      request.log.error({ err }, 'upload failed');
      return reply.code(400).send({ error: err.message });
    }
  });
}
