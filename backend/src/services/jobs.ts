// In-process job runner for the generate / heal pipelines.
//
// Why this exists:
//  - `/api/generate` used to run generation + up to 8 heal attempts (each a real
//    `npx playwright test` run plus an LLM call, some driving a headed browser)
//    inside one synchronous HTTP request. The extension made a plain fetch, so
//    closing the popup aborted the whole run.
//  - healingBrowser.ts keeps ONE module-level headed Chromium. Two overlapping
//    requests would call getSession() and tear each other's browser down mid-run.
//
// Both problems go away if the work runs as a background job on a strictly serial
// queue: the route returns a job id immediately, the client streams progress over
// SSE (routes/jobs.ts), and only ever one job — one heal loop, one browser — is
// active at a time.
//
// State is in-memory only. A process restart loses in-flight jobs; that is
// acceptable for a single-process MVP (a client that reconnects to a lost id just
// gets a 404 and can regenerate).
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';

export type JobKind = 'generate' | 'heal';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobEvent {
  /** Monotonic per-job. Emitted as the SSE `id:` field so a reconnecting
   *  EventSource can resume via Last-Event-ID. */
  seq: number;
  /** SSE event name: 'phase' | 'generated' | 'heal:attempt-start' |
   *  'heal:run-result' | 'heal:diagnosis' | 'heal:browser' | 'done' | 'error' |
   *  'end'. */
  type: string;
  data: unknown;
  ts: number;
}

export interface JobContext {
  id: string;
  signal: AbortSignal;
  emit: (type: string, data?: unknown) => void;
  /** Throw if the job has been cancelled — call at await boundaries so a
   *  DELETE /api/jobs/:id stops the pipeline promptly. */
  throwIfCancelled: () => void;
}

type JobHandler = (ctx: JobContext) => Promise<unknown>;

interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  events: JobEvent[];
  result?: unknown;
  error?: string;
  emitter: EventEmitter;
  abort: AbortController;
  handler: JobHandler;
  createdAt: number;
  finishedAt?: number;
}

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelledError';
  }
}

const DONE_TTL_MS = 30 * 60_000;

const jobs = new Map<string, Job>();
const waiting: string[] = [];
let active: string | null = null;

function emit(job: Job, type: string, data: unknown = {}): void {
  const ev: JobEvent = { seq: job.events.length + 1, type, data, ts: Date.now() };
  job.events.push(ev);
  job.emitter.emit('event', ev);
}

function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

function renumberQueue(): void {
  waiting.forEach((qid, i) => {
    const qj = jobs.get(qid);
    if (qj && qj.status === 'queued') {
      emit(qj, 'phase', {
        phase: 'queued',
        message: i === 0 ? 'Queued — next up' : `Queued — ${i} ahead`,
        queuePosition: i,
      });
    }
  });
}

async function pump(): Promise<void> {
  if (active) return;
  let job: Job | undefined;
  while (waiting.length > 0) {
    const id = waiting.shift()!;
    const candidate = jobs.get(id);
    if (candidate && candidate.status === 'queued') {
      job = candidate;
      break;
    }
    // else: cancelled or swept while queued — skip
  }
  if (!job) return;

  active = job.id;
  job.status = 'running';
  renumberQueue();

  const ctx: JobContext = {
    id: job.id,
    signal: job.abort.signal,
    emit: (type, data) => emit(job!, type, data),
    throwIfCancelled: () => {
      if (job!.abort.signal.aborted) throw new JobCancelledError();
    },
  };

  try {
    const result = await job.handler(ctx);
    if (job.abort.signal.aborted) {
      job.status = 'cancelled';
    } else {
      job.result = result;
      job.status = 'done';
    }
  } catch (err) {
    if (job.abort.signal.aborted || err instanceof JobCancelledError) {
      job.status = 'cancelled';
      emit(job, 'phase', { phase: 'error', message: 'Cancelled' });
    } else {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] job ${job.id} (${job.kind}) failed:`, err);
      emit(job, 'error', { message: job.error });
    }
  } finally {
    job.finishedAt = Date.now();
    emit(job, 'end', { status: job.status });
    active = null;
    scheduleSweep(job.id);
    void pump();
  }
}

function scheduleSweep(id: string): void {
  setTimeout(() => {
    const job = jobs.get(id);
    if (job && isTerminal(job.status)) {
      job.emitter.removeAllListeners();
      jobs.delete(id);
    }
  }, DONE_TTL_MS).unref?.();
}

export function enqueue(kind: JobKind, handler: JobHandler): string {
  const id = nanoid(10);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const job: Job = {
    id,
    kind,
    status: 'queued',
    events: [],
    emitter,
    abort: new AbortController(),
    handler,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  waiting.push(id);
  emit(job, 'phase', {
    phase: 'queued',
    message: waiting.length === 1 && !active ? 'Starting' : 'Queued',
    queuePosition: Math.max(0, waiting.length - 1),
  });
  void pump();
  return id;
}

export function cancel(id: string): boolean {
  const job = jobs.get(id);
  if (!job || isTerminal(job.status)) return false;
  job.abort.abort();
  if (job.status === 'queued') {
    // Not running yet — pump() will skip it; close it out now so subscribers see the end.
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    emit(job, 'phase', { phase: 'error', message: 'Cancelled' });
    emit(job, 'end', { status: 'cancelled' });
    scheduleSweep(id);
  }
  return true;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  status: JobStatus;
  events: JobEvent[];
  result?: unknown;
  error?: string;
}

export function getSnapshot(id: string): JobSnapshot | null {
  const job = jobs.get(id);
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    events: job.events,
    result: job.result,
    error: job.error,
  };
}

/** Live handle for the SSE route: buffered events + an emitter that fires
 *  `('event', JobEvent)` for every subsequent event, including the terminal
 *  `end`. Returns null if the id is unknown. */
export function getStream(id: string): { events: JobEvent[]; emitter: EventEmitter; done: boolean } | null {
  const job = jobs.get(id);
  if (!job) return null;
  return { events: job.events, emitter: job.emitter, done: isTerminal(job.status) };
}
