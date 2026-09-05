import type { FastifyInstance } from 'fastify';
import { loadGeneratedTest, loadRecording, updateGeneratedTest } from '../services/storage.js';
import { healTest } from '../services/healingGraph.js';
import type { RecordedAction } from '../types.js';

export default async function healRoutes(app: FastifyInstance) {
  app.post('/api/heal/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = loadGeneratedTest(id);
    if (!record) return reply.status(404).send({ error: 'Not found' });

    const body = (request.body as { maxAttempts?: number } | undefined) ?? {};
    const maxAttempts = Math.min(Math.max(Number(body.maxAttempts) || 3, 1), 5);

    const recording = loadRecording(id) as { actions?: RecordedAction[] } | null;

    try {
      const result = await healTest({
        testCase: record.testCase,
        code: record.playwrightCode,
        specFile: record.specFile,
        maxAttempts,
        recordedActions: recording?.actions,
      });

      if (result.code !== record.playwrightCode) {
        updateGeneratedTest(id, result.code);
      }

      return {
        id,
        status: result.status,
        attempts: result.attempt,
        suspectedRealBug: result.suspectedRealBug,
        finalCode: result.code,
        history: result.history,
      };
    } catch (err) {
      request.log.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: 'Self-healing failed', message });
    }
  });
}
