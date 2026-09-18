import type { FastifyInstance } from 'fastify';
import { loadGeneratedTest, loadRecording, updateGeneratedTest } from '../services/storage.js';
import { healTest, MAX_HEAL_ATTEMPTS } from '../services/healingGraph.js';
import { enqueue, type JobContext } from '../services/jobs.js';
import type { RecordedAction } from '../types.js';

interface HealJobInput {
  recordId: string;
  maxAttempts: number;
}

// Same job/SSE model as /api/generate, minus the generation phase — the results
// page streams both the same way.
async function runHealJob(ctx: JobContext, input: HealJobInput) {
  const record = loadGeneratedTest(input.recordId);
  if (!record) throw new Error(`No generated test found for id ${input.recordId}`);
  const recording = loadRecording(input.recordId) as { actions?: RecordedAction[] } | null;

  ctx.emit('generated', {
    testCase: record.testCase,
    playwrightCode: record.playwrightCode,
    specFile: record.specFile,
  });
  ctx.emit('phase', { phase: 'healing', message: 'Self-healing' });

  const result = await healTest({
    testCase: record.testCase,
    code: record.playwrightCode,
    specFile: record.specFile,
    maxAttempts: input.maxAttempts,
    recordedActions: recording?.actions,
    signal: ctx.signal,
    onEvent: (ev) => ctx.emit(ev.type, ev),
  });

  if (result.code !== record.playwrightCode) {
    updateGeneratedTest(input.recordId, { playwrightCode: result.code });
  }

  const done = {
    id: input.recordId,
    testCase: record.testCase,
    specFile: record.specFile,
    working: result.status === 'passed',
    finalCode: result.code,
    healing: {
      status: result.status,
      attempts: result.attempt,
      suspectedRealBug: result.suspectedRealBug,
      history: result.history,
    },
  };
  ctx.emit('phase', { phase: 'done', message: done.working ? 'Passed' : 'Finished — needs review' });
  ctx.emit('done', done);
  return done;
}

export default async function healRoutes(app: FastifyInstance) {
  app.post('/api/heal/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = loadGeneratedTest(id);
    if (!record) return reply.status(404).send({ error: 'Not found' });

    const body = (request.body as { maxAttempts?: number } | undefined) ?? {};
    const maxAttempts = Math.min(Math.max(Number(body.maxAttempts) || MAX_HEAL_ATTEMPTS, 1), MAX_HEAL_ATTEMPTS);

    const jobId = enqueue('heal', (ctx) => runHealJob(ctx, { recordId: id, maxAttempts }));
    return reply.status(202).send({ id: jobId });
  });
}
