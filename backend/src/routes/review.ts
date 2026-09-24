// Human-in-the-loop review for RECURRING likelyRealBug verdicts only — see
// reviewStore.ts for why a single flagged run never lands here. This is the
// backing API for the review panel the results page (extension/src/run.ts)
// shows when a 'heal:review' SSE event fires.
import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadCases, findCaseById, upsertCase } from '../services/reviewStore.js';
import { loadGeneratedTest, loadRecording, updateGeneratedTest } from '../services/storage.js';
import { healTest, MAX_HEAL_ATTEMPTS } from '../services/healingGraph.js';
import { validateSpecCode } from '../services/scriptValidator.js';
import { enqueue, type JobContext } from '../services/jobs.js';
import type { RecordedAction } from '../types.js';

const ARTIFACT_DIR = path.resolve('test-results', 'heal');

interface GuidedHealInput {
  recordId: string;
  caseId: string;
  hint: string;
}

// Same shape as heal.ts's runHealJob, plus the human's hint threaded into
// healTest as authoritative context, and the review case updated with the
// outcome once it's known.
async function runGuidedHealJob(ctx: JobContext, input: GuidedHealInput) {
  const record = loadGeneratedTest(input.recordId);
  if (!record) throw new Error(`No generated test found for id ${input.recordId}`);
  const recording = loadRecording(input.recordId) as { actions?: RecordedAction[] } | null;

  ctx.emit('generated', { testCase: record.testCase, playwrightCode: record.playwrightCode, specFile: record.specFile });
  ctx.emit('phase', { phase: 'healing', message: 'Self-healing (guided by a human review hint)' });

  const result = await healTest({
    testCase: record.testCase,
    code: record.playwrightCode,
    specFile: record.specFile,
    testId: input.recordId,
    maxAttempts: MAX_HEAL_ATTEMPTS,
    recordedActions: recording?.actions,
    humanHint: input.hint,
    signal: ctx.signal,
    onEvent: (ev) => ctx.emit(ev.type, ev),
  });

  let codeToPersist = result.code;
  if (result.code !== record.playwrightCode) {
    if (result.status === 'passed') {
      updateGeneratedTest(input.recordId, { playwrightCode: result.code });
    } else {
      const validation = validateSpecCode(result.code);
      if (validation.valid) {
        updateGeneratedTest(input.recordId, { playwrightCode: result.code });
      } else {
        codeToPersist = record.playwrightCode;
      }
    }
  }

  const current = findCaseById(input.caseId);
  if (current) {
    upsertCase({ ...current, status: result.status === 'passed' ? 'reheal-passed' : 'reheal-failed', decidedAt: new Date().toISOString() });
  }

  const done = {
    id: input.recordId,
    testCase: record.testCase,
    specFile: record.specFile,
    working: result.status === 'passed',
    finalCode: codeToPersist,
    healing: { status: result.status, attempts: result.attempt, suspectedRealBug: result.suspectedRealBug, history: result.history },
  };
  ctx.emit('phase', { phase: 'done', message: done.working ? 'Passed' : 'Finished — needs review' });
  ctx.emit('done', done);
  return done;
}

export default async function reviewRoutes(app: FastifyInstance) {
  app.get('/api/review', async () => {
    const cases = loadCases().sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return cases.map((c) => ({ ...c, screenshotUrl: c.screenshotPath ? `/api/review/${c.id}/screenshot` : undefined }));
  });

  app.get('/api/review/:id/screenshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    const reviewCase = findCaseById(id);
    if (!reviewCase?.screenshotPath) return reply.status(404).send({ error: 'Not found' });
    // Defense in depth: the path is always server-generated (healingBrowser.ts's
    // screenshot()), never user input, but confirm it still resolves under the
    // one directory heal screenshots are ever written to before reading it.
    const resolved = path.resolve(reviewCase.screenshotPath);
    if (!resolved.startsWith(ARTIFACT_DIR + path.sep) || !existsSync(resolved)) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.type('image/png').send(readFileSync(resolved));
  });

  app.post('/api/review/:id/confirm', async (request, reply) => {
    const { id } = request.params as { id: string };
    const reviewCase = findCaseById(id);
    if (!reviewCase) return reply.status(404).send({ error: 'Not found' });
    upsertCase({ ...reviewCase, status: 'confirmed-bug', decidedAt: new Date().toISOString() });
    return { ok: true };
  });

  app.post('/api/review/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string };
    const reviewCase = findCaseById(id);
    if (!reviewCase) return reply.status(404).send({ error: 'Not found' });
    upsertCase({ ...reviewCase, status: 'dismissed', decidedAt: new Date().toISOString() });
    return { ok: true };
  });

  app.post('/api/review/:id/hint', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { hint } = (request.body as { hint?: string } | undefined) ?? {};
    if (!hint || !hint.trim()) return reply.status(400).send({ error: 'hint is required' });
    const reviewCase = findCaseById(id);
    if (!reviewCase) return reply.status(404).send({ error: 'Not found' });
    if (!reviewCase.testId || !loadGeneratedTest(reviewCase.testId)) {
      return reply.status(404).send({ error: 'The test this case came from no longer exists' });
    }
    upsertCase({ ...reviewCase, status: 'reheal-requested', hint: hint.trim() });
    const jobId = enqueue('heal', (ctx) => runGuidedHealJob(ctx, { recordId: reviewCase.testId!, caseId: id, hint: hint.trim() }));
    return reply.status(202).send({ id: jobId });
  });
}
