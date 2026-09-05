// Self-healing loop: run the generated spec, and if it fails, ask Claude to
// diagnose + patch it, then run again — until it passes, a fix claims the
// failure is a real app regression (retrying identical code would be pointless),
// or maxAttempts is exhausted. LangGraph owns the run/fix/retry control flow;
// the nodes themselves are thin wrappers around the existing runner + LLM call.
//
// Every attempt (including the first) runs off a scratch copy in the same
// directory, never the real spec file the user has open — so the file on disk
// only ever changes once, at the very end, when the caller writes the final
// (passed, or best-effort) code back. Mid-loop fix attempts never flicker the
// real file.
import { writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { runPlaywrightTest } from './testRunner.js';
import { fixTest, type FixResult } from './anthropic.js';
import { getSession, type BreakPoint, type HealingSession } from './healingBrowser.js';
import type { GeneratedTestCase, RecordedAction } from '../types.js';
import type { TestRunResult } from './testRunner.js';

export interface HealAttempt {
  attempt: number;
  passed: boolean;
  output: string;
  diagnosis?: string;
}

// Progress events surfaced to the caller (the job runner forwards these straight
// onto the SSE stream). Attempt numbers are 1-based for display.
export type HealEvent =
  | { type: 'heal:attempt-start'; attempt: number; maxAttempts: number }
  | { type: 'heal:run-result'; attempt: number; passed: boolean; outputTail: string }
  | { type: 'heal:diagnosis'; attempt: number; diagnosis: string; likelyRealBug: boolean }
  | { type: 'heal:browser'; message: string };

const OUTPUT_TAIL_CHARS = 2000;
const noopEvent = (_ev: HealEvent): void => {};

// Describe *why* the replay parked, from the probe/action result the browser
// session attached — so both the SSE line and the fixer prompt say "matched 0
// elements" / "matched 3" / "action failed", not a blanket "no longer unique"
// (which sent the fixer chasing a healthy locator on the last run).
function breakPhrase(brk: BreakPoint): string {
  if (!brk.brokenLocatorExpr) return 'no locator broke (assertion or timing issue)';
  if (brk.actionError) return `locator resolved to one element but the recorded action failed: ${brk.actionError}`;
  const p = brk.brokenProbe;
  if (p?.error) return `locator expression errored: ${p.error}`;
  if (p && p.count === 0) return 'locator matched 0 elements at replay time';
  if (p && p.count > 1) return `locator matched ${p.count} elements${p.visibleCount === 1 ? ' (only 1 visible)' : ''}`;
  return 'locator no longer resolves to exactly one element';
}

// Default number of run→fix→run cycles, and the ceiling a per-request override is
// clamped to. Set MAX_HEAL_ATTEMPTS in the environment to change it.
export const MAX_HEAL_ATTEMPTS = Math.max(1, Math.trunc(Number(process.env.MAX_HEAL_ATTEMPTS)) || 4);

const HealState = Annotation.Root({
  testCase: Annotation<GeneratedTestCase>({ reducer: (_prev, next) => next, default: () => ({} as GeneratedTestCase) }),
  code: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  specFile: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  scratchFile: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  attempt: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  maxAttempts: Annotation<number>({ reducer: (_prev, next) => next, default: () => MAX_HEAL_ATTEMPTS }),
  status: Annotation<'running' | 'passed' | 'failed'>({ reducer: (_prev, next) => next, default: () => 'running' }),
  lastOutput: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  suspectedRealBug: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  // The last fix returned code byte-identical to what just failed — retrying it
  // would fail the same way, so stop instead of burning the remaining attempts.
  stalled: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  history: Annotation<HealAttempt[]>({ reducer: (_prev, next) => next, default: () => [] }),
});

type HealStateType = typeof HealState.State;

// Real Playwright execution and the LLM call are injected rather than imported
// directly by the nodes, so the graph's control flow (run/fix/retry/stop) can be
// exercised in tests without a browser or network access.
export interface HealingGraphDeps {
  run: (specFile: string) => Promise<TestRunResult>;
  fix: (testCase: GeneratedTestCase, code: string, failureOutput: string) => Promise<FixResult>;
}

function buildGraph(deps: HealingGraphDeps, onEvent: (ev: HealEvent) => void = noopEvent) {
  async function runNode(state: HealStateType): Promise<Partial<HealStateType>> {
    onEvent({ type: 'heal:attempt-start', attempt: state.attempt + 1, maxAttempts: state.maxAttempts });
    // Always run off the scratch copy, never the real specFile — fixNode only
    // updates state.code in memory, and writing each attempt to the file the
    // user has open would flicker/overwrite it on every iteration. The scratch
    // file is what Playwright actually executes; the real file is untouched
    // until the caller commits the final result once healing is done.
    writeFileSync(state.scratchFile, state.code);
    console.log(`[heal] attempt ${state.attempt}/${state.maxAttempts} — running scratch copy ${state.scratchFile}...`);
    const start = Date.now();
    const result = await deps.run(state.scratchFile);
    console.log(`[heal] attempt ${state.attempt}/${state.maxAttempts} — ${result.passed ? 'PASSED' : 'FAILED'} in ${Date.now() - start}ms`);
    onEvent({
      type: 'heal:run-result',
      attempt: state.attempt + 1,
      passed: result.passed,
      outputTail: result.output.slice(-OUTPUT_TAIL_CHARS),
    });
    return {
      lastOutput: result.output,
      status: result.passed ? 'passed' : 'failed',
      history: [...state.history, { attempt: state.attempt, passed: result.passed, output: result.output }],
    };
  }

  function routeAfterRun(state: HealStateType): 'fix' | typeof END {
    if (state.status === 'passed') {
      console.log(`[heal] test passes — done`);
      return END;
    }
    if (state.attempt >= state.maxAttempts) {
      console.log(`[heal] max attempts (${state.maxAttempts}) reached — giving up`);
      return END;
    }
    return 'fix';
  }

  async function fixNode(state: HealStateType): Promise<Partial<HealStateType>> {
    console.log(`[heal] attempt ${state.attempt}/${state.maxAttempts} — asking Claude to diagnose and patch the failure...`);
    const start = Date.now();
    const result = await deps.fix(state.testCase, state.code, state.lastOutput);
    console.log(`[heal] fix received in ${Date.now() - start}ms — likelyRealBug=${result.likelyRealBug}`);
    onEvent({
      type: 'heal:diagnosis',
      attempt: state.attempt + 1,
      diagnosis: result.diagnosis,
      likelyRealBug: result.likelyRealBug,
    });
    const history = state.history.slice();
    if (history.length > 0) {
      history[history.length - 1] = { ...history[history.length - 1], diagnosis: result.diagnosis };
    }
    const stalled = result.updatedPlaywrightCode.trim() === state.code.trim();
    return {
      code: result.updatedPlaywrightCode,
      attempt: state.attempt + 1,
      suspectedRealBug: result.likelyRealBug,
      stalled,
      history,
    };
  }

  function routeAfterFix(state: HealStateType): 'run' | typeof END {
    if (state.suspectedRealBug) {
      console.log(`[heal] fix flagged as a likely real app bug — stopping without retrying`);
      return END;
    }
    if (state.stalled) {
      console.log(`[heal] fix returned unchanged code — no progress, stopping`);
      return END;
    }
    return 'run';
  }

  return new StateGraph(HealState)
    .addNode('run', runNode)
    .addNode('fix', fixNode)
    .addEdge(START, 'run')
    .addConditionalEdges('run', routeAfterRun)
    .addConditionalEdges('fix', routeAfterFix)
    .compile();
}

export interface HealInput {
  testCase: GeneratedTestCase;
  code: string;
  specFile: string;
  maxAttempts?: number;
  // The enriched recording this test was generated from. When present, healTest
  // spins up a live headed browser, replays the flow to the broken step, and
  // hands the fixer live-DOM verification tools. Omit it (or pass `deps`) to run
  // the old text-only loop.
  recordedActions?: RecordedAction[];
  // Progress callback — the job runner forwards these onto the SSE stream.
  onEvent?: (ev: HealEvent) => void;
  // Cancellation: aborts the in-flight Playwright run and LLM call, and stops the
  // loop between nodes.
  signal?: AbortSignal;
}

// A crashed run can leave a `<base>.heal-<id>.spec.ts` behind; because the
// generated-tests config uses `testDir: '.'` every stale one gets re-executed on
// the next run. Sweep them before we start.
function sweepStaleScratch(dir: string) {
  try {
    for (const f of readdirSync(dir)) {
      if (/\.heal-[A-Za-z0-9_-]+\.spec\.ts$/.test(f)) {
        unlinkSync(path.join(dir, f));
        console.log(`[heal] removed stale scratch file ${f}`);
      }
    }
  } catch {
    /* dir missing / unreadable — nothing to sweep */
  }
}

export async function healTest(input: HealInput, depsOverride?: HealingGraphDeps): Promise<HealStateType> {
  const dir = path.dirname(input.specFile);
  const fileName = path.basename(input.specFile);
  // Insert the scratch token right before ".spec.ts" (not path.extname, which
  // would only strip ".ts") so the file still matches Playwright's default
  // "*.spec.ts" test-file pattern and actually gets picked up by the runner.
  const base = fileName.endsWith('.spec.ts') ? fileName.slice(0, -'.spec.ts'.length) : fileName.replace(/\.ts$/, '');
  sweepStaleScratch(dir);
  const scratchFile = path.join(dir, `${base}.heal-${nanoid(6)}.spec.ts`);

  const onEvent = input.onEvent ?? noopEvent;
  const { signal } = input;

  // Build the live-browser fixer deps unless the caller injected their own
  // (tests) or gave us no recording to replay.
  let session: HealingSession | undefined;
  let deps: HealingGraphDeps = depsOverride ?? {
    run: (specFile) => runPlaywrightTest(specFile, signal),
    fix: (testCase, code, failureOutput) => fixTest(testCase, code, failureOutput, undefined, signal),
  };
  if (!depsOverride && input.recordedActions?.length) {
    session = await getSession();
    onEvent({ type: 'heal:browser', message: 'Replaying the recorded flow in a live browser…' });
    const brk: BreakPoint = await session.replayUntilBroken(input.recordedActions);
    const breakSummary = breakPhrase(brk);
    const parkedMsg =
      `Replay parked at recorded step #${brk.actionIndex} — ${breakSummary}` +
      (brk.brokenLocatorExpr ? `: ${brk.brokenLocatorExpr}` : '');
    console.log(`[heal] ${parkedMsg}`);
    onEvent({ type: 'heal:browser', message: parkedMsg });
    const boundSession = session;
    deps = {
      run: (specFile) => runPlaywrightTest(specFile, signal),
      fix: (testCase, code, failureOutput) =>
        fixTest(
          testCase,
          code,
          failureOutput,
          {
            session: boundSession,
            brokenAction: brk.brokenAction,
            brokenLocatorExpr: brk.brokenLocatorExpr,
            actionIndex: brk.actionIndex,
            breakSummary,
          },
          signal
        ),
    };
  }

  const graph = buildGraph(deps, onEvent);
  let finalState: HealStateType | undefined;
  try {
    finalState = await graph.invoke({
      testCase: input.testCase,
      code: input.code,
      specFile: input.specFile,
      scratchFile,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? MAX_HEAL_ATTEMPTS,
      status: 'running',
      lastOutput: '',
      suspectedRealBug: false,
      stalled: false,
      history: [],
    });
    return finalState;
  } finally {
    if (existsSync(scratchFile)) unlinkSync(scratchFile);
    if (session) {
      if (finalState?.status === 'passed') {
        await session.teardown();
      } else {
        session.park();
        console.log('[heal] test still failing — headed browser left open at the failing step for manual takeover');
      }
    }
  }
}
