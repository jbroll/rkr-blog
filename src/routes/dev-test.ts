// Dev-only OPFS test harness. Active only when ENABLE_TEST_ROUTES=1.
// Usage: ENABLE_TEST_ROUTES=1 HOST=0.0.0.0 npm start
// Then navigate to http://<mac-ip>:<port>/_test on the target device.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

const HTML_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-test.html');

function broadcast(clients: Set<FastifyReply>, event: string): void {
  for (const reply of clients) {
    reply.raw.write(`event: ${event}\ndata: {}\n\n`);
  }
}

export default async function devTestRoutes(app: FastifyInstance): Promise<void> {
  const clients = new Set<FastifyReply>();

  // Keepalive: SSE connections go quiet after tests finish; browsers
  // close idle connections. A comment ping every 20s keeps them open.
  const heartbeat = setInterval(() => {
    for (const reply of clients) reply.raw.write(':\n\n');
  }, 20_000);

  const watcher = fs.watch(HTML_FILE, () => broadcast(clients, 'reload'));

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    watcher.close();
  });

  app.get('/_test', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(fs.readFileSync(HTML_FILE, 'utf8'));
  });

  app.post<{ Body: unknown }>('/_test/results', async (req, reply) => {
    process.stdout.write(`\n[_test]\n${JSON.stringify(req.body, null, 2)}\n`);
    reply.send({ ok: true });
  });

  // GET so no CSRF — call from terminal: curl localhost:PORT/_test/reload
  app.get('/_test/reload', async (_req, reply) => {
    broadcast(clients, 'reload');
    reply.send({ ok: true, clients: clients.size });
  });

  app.get('/_test/events', (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(':\n\n');
    clients.add(reply);
    process.stdout.write(`[_test] SSE client connected (total: ${clients.size})\n`);
    reply.raw.on('close', () => {
      clients.delete(reply);
      process.stdout.write(`[_test] SSE client disconnected (total: ${clients.size})\n`);
    });
  });
}
