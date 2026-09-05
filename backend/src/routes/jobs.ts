// Read/observe/cancel endpoints for background jobs (see services/jobs.ts).
//
//   GET    /api/jobs/:id          one-shot JSON snapshot (status + all events so far)
//   GET    /api/jobs/:id/events   Server-Sent Events stream of progress
//   DELETE /api/jobs/:id          request cancellation
import type { FastifyInstance } from 'fastify';
import { isAllowedOrigin } from '../cors.js';
import { cancel, getSnapshot, getStream, type JobEvent } from '../services/jobs.js';

const KEEPALIVE_MS = 15_000;

export default async function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const snapshot = getSnapshot(id);
    if (!snapshot) return reply.status(404).send({ error: 'Not found' });
    return snapshot;
  });

  app.get('/api/jobs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string };
    const stream = getStream(id);
    if (!stream) {
      reply.status(404).send({ error: 'Not found' });
      return;
    }

    // Take over the socket: the cors plugin's onSend hook won't run after this,
    // so the CORS header has to be set by hand with the shared origin rule.
    reply.hijack();
    const raw = reply.raw;
    const origin = request.headers.origin;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(isAllowedOrigin(origin) && origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    });
    raw.write('retry: 3000\n\n');

    const headerLastId = Number(request.headers['last-event-id']);
    const queryLastId = Number((request.query as { lastEventId?: string })?.lastEventId);
    const lastId = Number.isFinite(headerLastId)
      ? headerLastId
      : Number.isFinite(queryLastId)
        ? queryLastId
        : 0;

    const send = (ev: JobEvent) => {
      raw.write(`id: ${ev.seq}\n`);
      raw.write(`event: ${ev.type}\n`);
      raw.write(`data: ${JSON.stringify(ev.data)}\n\n`);
    };

    // Replay everything the client hasn't seen.
    let sawEnd = false;
    for (const ev of stream.events) {
      if (ev.seq > lastId) {
        send(ev);
        if (ev.type === 'end') sawEnd = true;
      }
    }

    if (sawEnd || stream.done) {
      raw.end();
      return;
    }

    const onEvent = (ev: JobEvent) => {
      send(ev);
      if (ev.type === 'end') {
        clearInterval(keepalive);
        stream.emitter.off('event', onEvent);
        raw.end();
      }
    };
    stream.emitter.on('event', onEvent);

    const keepalive = setInterval(() => raw.write(': keepalive\n\n'), KEEPALIVE_MS);

    request.raw.on('close', () => {
      clearInterval(keepalive);
      stream.emitter.off('event', onEvent);
    });
  });

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = cancel(id);
    if (!ok) return reply.status(404).send({ error: 'Not found or already finished' });
    return { ok: true };
  });
}
