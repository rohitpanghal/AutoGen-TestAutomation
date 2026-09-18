import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadGeneratedTest, updateGeneratedTest } from '../services/storage.js';

// QA edits land here, before or in place of the "Approve & Run" trigger
// (POST /api/heal/:id) — a synchronous file write, same cost class as
// GET /api/recordings/:id, no job/queue involvement.
const bodySchema = z.object({
  playwrightCode: z.string().optional(),
  testCase: z
    .object({
      title: z.string(),
      preconditions: z.array(z.string()),
      steps: z.array(
        z.object({
          description: z.string(),
          expectedResult: z.string().optional(),
        })
      ),
      expectedResults: z.array(z.string()),
    })
    .optional(),
});

export default async function testRoutes(app: FastifyInstance) {
  app.patch('/api/tests/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!loadGeneratedTest(id)) return reply.status(404).send({ error: 'Not found' });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    return updateGeneratedTest(id, parsed.data);
  });
}
