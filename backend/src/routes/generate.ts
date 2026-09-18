import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateTest } from '../services/anthropic.js';
import { enrichActions } from '../services/locatorBuilder.js';
import { saveRecording, saveGeneratedTest } from '../services/storage.js';
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
    frame: z
      .object({
        selectorChain: z.array(z.string()),
        crossOrigin: z.boolean(),
        frameUrl: z.string(),
      })
      .passthrough()
      .optional(),
    locatorCandidates: z
      .array(
        z
          .object({
            kind: z.string(),
            expr: z.string(),
            count: z.number(),
            isDefault: z.boolean().optional(),
          })
          .passthrough()
      )
      .optional(),
    // QA's explicit choice from the review page — wins verbatim over
    // everything else. See locatorBuilder.ts::buildLocatorExpression.
    locatorOverride: z.string().optional(),
  })
  .passthrough();

const actionSchema = z.object({
  action: z.enum(['click', 'input', 'select', 'navigate', 'mark_step', 'note', 'upload', 'keydown']),
  timestamp: z.number(),
  url: z.string(),
  element: elementSchema.optional(),
  value: z.string().optional(),
  masked: z.boolean().optional(),
  label: z.string().optional(),
  // User-authored intent added on the extension's review page.
  description: z.string().optional(),
  // 'upload' only: human-supplied real file path for setInputFiles(...).
  filePath: z.string().optional(),
});

const bodySchema = z.object({
  testName: z.string().min(1),
  actions: z.array(actionSchema).min(1),
  // Present when this recording was duplicated from another one for QA to
  // build a variant (e.g. a negative-path version) from an already-reviewed
  // flow — pure traceability, stored alongside the recording. See
  // GET /api/recordings/:id, which review.ts fetches from to seed the copy.
  parentId: z.string().optional(),
});

interface GenerateJobInput {
  testName: string;
  actions: RecordedAction[];
  parentId?: string;
}

// Generation only — this job stops once the spec is written and does NOT
// auto-heal/run it. That's a deliberate approval gate: QA reviews (and can
// edit) the generated test case + code on the results page, then explicitly
// triggers POST /api/heal/:id to actually run it. Runs as a background job so
// the HTTP request can return a job id immediately and the client streams
// progress over SSE (routes/jobs.ts). The job id doubles as the storage
// record id, so /api/heal/:id, /api/tests/:id and /api/recordings/:id take
// the same id the results page already holds.
async function runGenerateJob(ctx: JobContext, input: GenerateJobInput) {
  const { testName, actions, parentId } = input;
  const id = ctx.id;
  console.log(`[generate] (${id}) starting "${testName}" — ${actions.length} recorded actions`);
  debugBlock(`generate (${id}) INPUT actions`, actions);

  ctx.emit('phase', { phase: 'generating', message: `Generating "${testName}" — ${actions.length} actions` });

  const enrichedActions = enrichActions(actions);
  debugBlock(`generate (${id}) enriched actions (with suggestedLocator)`, enrichedActions);
  saveRecording(id, testName, enrichedActions, parentId);

  const genStart = Date.now();
  const { testCase, playwrightCode } = await generateTest(testName, enrichedActions, { signal: ctx.signal });
  ctx.throwIfCancelled();
  console.log(`[generate] (${id}) generation complete in ${Date.now() - genStart}ms — "${testCase.title}" (${testCase.steps.length} steps)`);
  debugBlock(`generate (${id}) OUTPUT testCase`, testCase);
  debugBlock(`generate (${id}) OUTPUT playwrightCode`, playwrightCode);

  // Deterministic backstop: the prompt requires every expectedResults entry to
  // be backed by a real expect() call. We don't reject/retry on this (yet) —
  // just surface it, mirroring the "verify the LLM's claim" pattern used
  // elsewhere (locatorBuilder, the heal loop's try_locator probe).
  const assertionCount = (playwrightCode.match(/expect\(/g) ?? []).length;
  if (testCase.expectedResults.length > 0 && assertionCount === 0) {
    console.warn(
      `[generate] (${id}) testCase claims ${testCase.expectedResults.length} expected result(s) but playwrightCode has 0 expect() calls`
    );
  }

  const specFile = saveGeneratedTest(id, testCase, playwrightCode);
  console.log(`[generate] (${id}) spec file written: ${specFile}`);
  ctx.emit('generated', { testCase, playwrightCode, specFile });

  // Stop here — no auto-heal. `awaitingApproval` tells the results page to
  // show the review/edit panel instead of finishing; QA explicitly triggers
  // POST /api/heal/:id (optionally after PATCH /api/tests/:id) when ready.
  const result = { id, testCase, playwrightCode, specFile, awaitingApproval: true };
  ctx.emit('phase', { phase: 'awaiting-approval', message: 'Generated — awaiting QA review' });
  ctx.emit('done', result);
  return result;
}

export default async function generateRoutes(app: FastifyInstance) {
  app.post('/api/generate', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const { testName, actions, parentId } = parsed.data;
    const jobId = enqueue('generate', (ctx) =>
      runGenerateJob(ctx, { testName, actions: actions as RecordedAction[], parentId })
    );
    return reply.status(202).send({ id: jobId });
  });
}
