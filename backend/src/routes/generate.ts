import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { generateTest } from '../services/anthropic.js';
import { enrichActions } from '../services/locatorBuilder.js';
import { saveRecording, saveGeneratedTest } from '../services/storage.js';
import type { RecordedAction } from '../types.js';

const actionSchema = z.object({
  action: z.enum(['click', 'input', 'select', 'navigate', 'mark_step']),
  timestamp: z.number(),
  url: z.string(),
  element: z.any().optional(),
  value: z.string().optional(),
  masked: z.boolean().optional(),
  label: z.string().optional(),
});

const bodySchema = z.object({
  testName: z.string().min(1),
  actions: z.array(actionSchema).min(1),
});

export default async function generateRoutes(app: FastifyInstance) {
  app.post('/api/generate', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { testName, actions } = parsed.data;
    const id = nanoid(10);
    const enrichedActions = enrichActions(actions as RecordedAction[]);
    saveRecording(id, testName, enrichedActions);

    try {
      const { testCase, playwrightCode } = await generateTest(testName, enrichedActions);
      const specFile = saveGeneratedTest(id, testCase, playwrightCode);
      return { id, testCase, playwrightCode, specFile };
    } catch (err) {
      request.log.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: 'AI generation failed', message });
    }
  });
}
