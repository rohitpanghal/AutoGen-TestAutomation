import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateTest } from '../services/anthropic.js';
import { enrichActions } from '../services/locatorBuilder.js';
import { saveRecording, saveGeneratedTest, updateGeneratedTest } from '../services/storage.js';
import { healTest, MAX_HEAL_ATTEMPTS } from '../services/healingGraph.js';
import { enqueue, type JobContext } from '../services/jobs.js';
import { debugBlock } from '../services/logging.js';
import type { RecordedAction } from '../types.js';

// The recorder's element descriptor. `.passthrough()` keeps new recorder fields
// from hard-failing generation; only `tag` (always emitted by content.ts) is
// required. The point is to reject a genuinely malformed payload — element is a
// string, element is null on an action that needs one — before it reaches the
// locator builder, not to police every field.
const elementSchema = z
  .object({
    tag: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    role: z.string().optional(),
    ariaLabel: z.string().optional(),
    text: z.string().optional(),
    textTruncated: z.boolean().optional(),
    css: z.string().optional(),
    xpath: z.string().optional(),
    nearbyText: z.string().optional(),
    xpathIsAnchored: z.boolean().optional(),
    testId: z.string().optional(),
    landmark: z.object({}).passthrough().optional(),
    ambiguous: z.boolean().optional(),
    testIdAmbiguous: z.boolean().optional(),
    roleTextAmbiguous: z.boolean().optional(),
    hiddenDuplicate: z.boolean().optional(),
    containerHint: z.object({}).passthrough().optional(),
    suggestedLocator: z.string().optional(),
  })
  .passthrough();

const actionSchema = z.object({
  action: z.enum(['click', 'input', 'select', 'navigate', 'mark_step', 'note']),
  timestamp: z.number(),
  url: z.string(),
  element: elementSchema.optional(),
  value: z.string().optional(),
  masked: z.boolean().optional(),
  label: z.string().optional(),
  // User-authored intent added on the extension's review page.
  description: z.string().optional(),
});

const bodySchema = z.object({
  testName: z.string().min(1),
  actions: z.array(actionSchema).min(1),
  maxHealAttempts: z.number().int().min(1).max(MAX_HEAL_ATTEMPTS).optional(),
});

interface GenerateJobInput {
  testName: string;
  actions: RecordedAction[];
  maxHealAttempts?: number;
}

// The heavy work — generation + the full self-heal loop — runs here as a
// background job so the HTTP request can return a job id immediately and the
// client streams progress over SSE (routes/jobs.ts). The job id doubles as the
// storage record id, so /api/heal/:id and /api/recordings/:id take the same id
// the results page already holds.
async function runGenerateJob(ctx: JobContext, input: GenerateJobInput) {
  const { testName, actions, maxHealAttempts } = input;
  const id = ctx.id;
  console.log(`[generate] (${id}) starting "${testName}" — ${actions.length} recorded actions`);
  debugBlock(`generate (${id}) INPUT actions`, actions);

  ctx.emit('phase', { phase: 'generating', message: `Generating "${testName}" — ${actions.length} actions` });

  const enrichedActions = enrichActions(actions);
  debugBlock(`generate (${id}) enriched actions (with suggestedLocator)`, enrichedActions);
  saveRecording(id, testName, enrichedActions);

  const genStart = Date.now();
  const { testCase, playwrightCode } = await generateTest(testName, enrichedActions, { signal: ctx.signal });
  ctx.throwIfCancelled();
  console.log(`[generate] (${id}) generation complete in ${Date.now() - genStart}ms — "${testCase.title}" (${testCase.steps.length} steps)`);
  debugBlock(`generate (${id}) OUTPUT testCase`, testCase);
  debugBlock(`generate (${id}) OUTPUT playwrightCode`, playwrightCode);

  const specFile = saveGeneratedTest(id, testCase, playwrightCode);
  console.log(`[generate] (${id}) spec file written: ${specFile}`);
  ctx.emit('generated', { testCase, playwrightCode, specFile });

  ctx.emit('phase', { phase: 'healing', message: 'Verifying & self-healing' });
  const healStart = Date.now();
  const healResult = await healTest({
    testCase,
    code: playwrightCode,
    specFile,
    maxAttempts: maxHealAttempts ?? MAX_HEAL_ATTEMPTS,
    recordedActions: enrichedActions,
    signal: ctx.signal,
    onEvent: (ev) => ctx.emit(ev.type, ev),
  });
  console.log(`[generate] (${id}) self-heal finished in ${Date.now() - healStart}ms — status=${healResult.status}, attempts=${healResult.attempt}`);

  if (healResult.code !== playwrightCode) {
    updateGeneratedTest(id, healResult.code);
    debugBlock(`generate (${id}) FINAL healed playwrightCode`, healResult.code);
  }
  debugBlock(`generate (${id}) heal history`, healResult.history);

  const result = {
    id,
    testCase,
    specFile,
    working: healResult.status === 'passed',
    finalCode: healResult.code,
    healing: {
      status: healResult.status,
      attempts: healResult.attempt,
      suspectedRealBug: healResult.suspectedRealBug,
      history: healResult.history,
    },
  };
  ctx.emit('phase', { phase: 'done', message: result.working ? 'Passed' : 'Finished — needs review' });
  ctx.emit('done', result);
  return result;
}

export default async function generateRoutes(app: FastifyInstance) {
  app.post('/api/generate', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const { testName, actions, maxHealAttempts } = parsed.data;
    const jobId = enqueue('generate', (ctx) =>
      runGenerateJob(ctx, { testName, actions: actions as RecordedAction[], maxHealAttempts })
    );
    return reply.status(202).send({ id: jobId });
  });
}
