import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { generateTest } from '../services/anthropic.js';
import { enrichActions } from '../services/locatorBuilder.js';
import { saveRecording, saveGeneratedTest, updateGeneratedTest } from '../services/storage.js';
import { healTest } from '../services/healingGraph.js';
import type { RecordedAction } from '../types.js';

function logBlock(label: string, data: unknown) {
  console.log(`----- ${label} -----`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(`----- end ${label} -----`);
}

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
  maxHealAttempts: z.number().int().min(1).max(5).optional(),
});

export default async function generateRoutes(app: FastifyInstance) {
  app.post('/api/generate', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { testName, actions, maxHealAttempts } = parsed.data;
    const id = nanoid(10);
    console.log(`\n[generate] (${id}) starting "${testName}" — ${actions.length} recorded actions`);
    logBlock(`generate (${id}) INPUT actions`, actions);

    const enrichedActions = enrichActions(actions as RecordedAction[]);
    console.log(`[generate] (${id}) locators built for ${enrichedActions.filter((a) => a.element).length} actions with elements`);
    logBlock(`generate (${id}) enriched actions (with suggestedLocator)`, enrichedActions);

    saveRecording(id, testName, enrichedActions);
    console.log(`[generate] (${id}) recording saved`);

    try {
      console.log(`[generate] (${id}) calling Claude to generate test case + Playwright code...`);
      const genStart = Date.now();
      const { testCase, playwrightCode } = await generateTest(testName, enrichedActions);
      console.log(`[generate] (${id}) generation complete in ${Date.now() - genStart}ms — "${testCase.title}" (${testCase.steps.length} steps)`);
      logBlock(`generate (${id}) OUTPUT testCase`, testCase);
      logBlock(`generate (${id}) OUTPUT playwrightCode`, playwrightCode);

      const specFile = saveGeneratedTest(id, testCase, playwrightCode);
      console.log(`[generate] (${id}) spec file written: ${specFile}`);

      // Verify + auto-heal before this test case is ever shown to the user —
      // nobody should have to click a button to find out the AI-generated
      // code doesn't actually run.
      console.log(`[generate] (${id}) running self-heal loop (max ${maxHealAttempts ?? 3} attempts)...`);
      const healStart = Date.now();
      const healResult = await healTest({
        testCase,
        code: playwrightCode,
        specFile,
        maxAttempts: maxHealAttempts ?? 3,
        recordedActions: enrichedActions,
      });
      console.log(`[generate] (${id}) self-heal finished in ${Date.now() - healStart}ms — status=${healResult.status}, attempts=${healResult.attempt}`);

      if (healResult.code !== playwrightCode) {
        updateGeneratedTest(id, healResult.code);
        console.log(`[generate] (${id}) spec file updated with healed code`);
        logBlock(`generate (${id}) FINAL healed playwrightCode`, healResult.code);
      }
      logBlock(`generate (${id}) heal history`, healResult.history);

      const response = {
        id,
        testCase,
        playwrightCode: healResult.code,
        specFile,
        working: healResult.status === 'passed',
        healing: {
          status: healResult.status,
          attempts: healResult.attempt,
          suspectedRealBug: healResult.suspectedRealBug,
          history: healResult.history,
        },
      };
      console.log(`[generate] (${id}) responding — working=${response.working}`);
      return response;
    } catch (err) {
      console.error(`[generate] (${id}) FAILED:`, err);
      request.log.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: 'AI generation failed', message });
    }
  });
}
