import type { FastifyInstance } from 'fastify';
import { loadRecording } from '../services/storage.js';

export default async function recordingRoutes(app: FastifyInstance) {
  app.get('/api/recordings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const recording = loadRecording(id);
    if (!recording) return reply.status(404).send({ error: 'Not found' });
    return recording;
  });
}
