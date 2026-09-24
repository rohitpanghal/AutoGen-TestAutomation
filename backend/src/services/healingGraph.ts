// Self-healing loop: run the generated spec, and if it fails, hand off to one
// continuous agentic fix session — the model edits the test, runs it for real,
// reads the actual result, and keeps iterating (the same edit/run/observe loop
// Claude Code itself uses) until it passes, it flags a real app regression, or
// it exhausts maxAttempts. LangGraph owns the two-step shape (run once, then
// fix); the fix session itself owns every retry after that, with one
// continuous model conversation instead of a fresh, memoryless call per retry.
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
import { runFixSession, extractFailingLocator, type FixSessionParams, type FixSessionResult, type BrowserFixSupport } from './anthropic.js';
import { getSession, type BreakPoint, type HealingSession } from './healingBrowser.js';
import { classifyFailure, type FailureSignature } from './failureClassifier.js';
import { appendRecovery, diffLines } from './recoveryStore.js';
import type { RepairStrategy } from './healingStrategy.js';
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
  | { type: 'heal:browser'; message: string }
  // The Healing Strategy step: which repair strategy is active, and why it's
  // being reported now — the initial diagnosis, a switch after the failure
  // shape changed (re-diagnose), or a repeat of the same strategy (escalate).
  | { type: 'heal:strategy'; attempt: number; strategy: RepairStrategy; reason: 'initial' | 're-diagnosed' | 'escalated' }
  // Emitted once per heal session that started from a failing run, after the
  // outcome has been appended to the recovery store.
  | { type: 'heal:recorded'; recoveryId: string; signature: FailureSignature };

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

// Default number of fix attempts the agentic session gets after the first run,
// and the ceiling a per-request override is clamped to. Set MAX_HEAL_ATTEMPTS
// in the environment to change it.
export const MAX_HEAL_ATTEMPTS = Math.max(1, Math.trunc(Number(process.env.MAX_HEAL_ATTEMPTS)) || 4);

const HealState = Annotation.Root({
  testCase: Annotation<GeneratedTestCase>({ reducer: (_prev, next) => next, default: () => ({} as GeneratedTestCase) }),
  code: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  specFile: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  scratchFile: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  maxAttempts: Annotation<number>({ reducer: (_prev, next) => next, default: () => MAX_HEAL_ATTEMPTS }),
  status: Annotation<'running' | 'passed' | 'failed'>({ reducer: (_prev, next) => next, default: () => 'running' }),
  lastOutput: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  suspectedRealBug: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  // How many additional runs (beyond the first) the fix session actually
  // executed — the same thing `state.attempt` used to count via the outer loop.
  attempt: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  history: Annotation<HealAttempt[]>({ reducer: (_prev, next) => next, default: () => [] }),
});

type HealStateType = typeof HealState.State;

// Real Playwright execution and the LLM fix session are injected rather than
// imported directly by the nodes, so the graph's control flow (run/fix/stop)
// can be exercised in tests without a browser or network access.
export interface HealingGraphDeps {
  run: (specFile: string) => Promise<TestRunResult>;
  fix: (params: Omit<FixSessionParams, 'browser' | 'signal'>) => Promise<FixSessionResult>;
}

function buildGraph(deps: HealingGraphDeps, onEvent: (ev: HealEvent) => void = noopEvent) {
  async function runNode(state: HealStateType): Promise<Partial<HealStateType>> {
    // Displayed denominator is the total run budget (this initial run plus
    // every fix attempt), not just state.maxAttempts (the fix budget alone) —
    // otherwise the last fix attempt shows as e.g. "5/4" (see fixNode).
    onEvent({ type: 'heal:attempt-start', attempt: state.attempt + 1, maxAttempts: state.maxAttempts + 1 });
    // Always run off the scratch copy, never the real specFile — the fix
    // session only updates state.code in memory, and writing each attempt to
    // the file the user has open would flicker/overwrite it on every
    // iteration. The scratch file is what Playwright actually executes; the
    // real file is untouched until the caller commits the final result once
    // healing is done.
    writeFileSync(state.scratchFile, state.code);
    console.log(`[heal] attempt ${state.attempt + 1} — running scratch copy ${state.scratchFile}...`);
    const start = Date.now();
    const result = await deps.run(state.scratchFile);
    console.log(`[heal] attempt ${state.attempt + 1} — ${result.passed ? 'PASSED' : 'FAILED'} in ${Date.now() - start}ms`);
    onEvent({
      type: 'heal:run-result',
      attempt: state.attempt + 1,
      passed: result.passed,
      outputTail: result.output.slice(-OUTPUT_TAIL_CHARS),
    });
    return {
      lastOutput: result.output,
      status: result.passed ? 'passed' : 'failed',
      history: [...state.history, { attempt: state.attempt + 1, passed: result.passed, output: result.output }],
    };
  }

  function routeAfterRun(state: HealStateType): 'fix' | typeof END {
    if (state.status === 'passed') {
      console.log(`[heal] test passes — done`);
      return END;
    }
    if (state.maxAttempts <= 0) {
      console.log(`[heal] no fix attempts configured — giving up`);
      return END;
    }
    return 'fix';
  }

  // One agentic session owns every retry from here: it runs its own
  // candidates, reads the real output, and decides for itself when to stop.
  async function fixNode(state: HealStateType): Promise<Partial<HealStateType>> {
    const runCandidate = async (code: string): Promise<TestRunResult> => {
      writeFileSync(state.scratchFile, code);
      return deps.run(state.scratchFile);
    };
    console.log(`[heal] handing off to the fix session — up to ${state.maxAttempts} more attempt(s)`);
    const session = await deps.fix({
      testCase: state.testCase,
      code: state.code,
      failureOutput: state.lastOutput,
      maxFixAttempts: state.maxAttempts,
      lastAttemptNumber: state.attempt + 1,
      runCandidate,
      onAttemptStart: (attempt) => onEvent({ type: 'heal:attempt-start', attempt, maxAttempts: state.maxAttempts + 1 }),
      onRunResult: (attempt, passed, output) =>
        onEvent({ type: 'heal:run-result', attempt, passed, outputTail: output.slice(-OUTPUT_TAIL_CHARS) }),
      onDiagnosis: (attempt, diagnosis, likelyRealBug) => onEvent({ type: 'heal:diagnosis', attempt, diagnosis, likelyRealBug }),
      onBrowserMessage: (message) => onEvent({ type: 'heal:browser', message }),
      onStrategy: (attempt, strategy, reason) => onEvent({ type: 'heal:strategy', attempt, strategy, reason }),
    });
    console.log(`[heal] fix session ended — status=${session.status}, likelyRealBug=${session.likelyRealBug}, runs=${session.history.length}`);
    return {
      code: session.code,
      status: session.status,
      suspectedRealBug: session.likelyRealBug,
      lastOutput: session.history.length ? session.history[session.history.length - 1].output : state.lastOutput,
      attempt: state.attempt + session.history.length,
      history: [...state.history, ...session.history],
    };
  }

  return new StateGraph(HealState)
    .addNode('run', runNode)
    .addNode('fix', fixNode)
    .addEdge(START, 'run')
    .addConditionalEdges('run', routeAfterRun)
    .addEdge('fix', END)
    .compile();
}

export interface HealInput {
  testCase: GeneratedTestCase;
  code: string;
  specFile: string;
  // Stored-test id, recorded with the recovery so a heal can be traced back.
  testId?: string;
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

// Append this session's outcome to the recovery store. A run that passed first
// time has nothing to learn from, and a memory write must never fail a heal.
function recordRecovery(
  input: HealInput,
  state: HealStateType,
  firstBreak: BreakPoint | undefined,
  onEvent: (ev: HealEvent) => void
) {
  const first = state.history[0];
  if (!first || first.passed) return;
  try {
    const signature = classifyFailure(first.output, firstBreak);
    const { removedLines, addedLines } = diffLines(input.code, state.code);
    const recoveryId = nanoid(10);
    appendRecovery({
      id: recoveryId,
      createdAt: new Date().toISOString(),
      testId: input.testId,
      testTitle: input.testCase.title,
      signature,
      outcome: state.status === 'passed' ? 'passed' : state.suspectedRealBug ? 'real-bug' : 'failed',
      attempts: state.history.length,
      removedLines,
      addedLines,
      strategy: null,
      usedLiveBrowser: Boolean(firstBreak),
    });
    console.log(`[heal] recorded recovery ${recoveryId} — ${signature.kind}, outcome=${state.status}`);
    onEvent({ type: 'heal:recorded', recoveryId, signature });
  } catch (err) {
    console.warn(`[heal] could not record recovery: ${(err as Error).message}`);
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
  // The break point the FIRST replay parked at — the runtime state that goes
  // into the failure signature. Later re-syncs don't overwrite it.
  let firstBreak: BreakPoint | undefined;
  let deps: HealingGraphDeps = depsOverride ?? {
    run: (specFile) => runPlaywrightTest(specFile, signal),
    fix: (params) => runFixSession({ ...params, signal }),
  };
  if (!depsOverride && input.recordedActions?.length) {
    session = await getSession();
    // A working copy the browser-agent path can patch as fixes land, kept
    // separate from input.recordedActions (untouched, used for nothing
    // else). Replaying the ORIGINAL recording verbatim on every attempt
    // would just re-hit the same first break forever — baking each
    // attempt's verifiedLocator into this copy is what lets a later
    // re-replay actually get past an already-fixed step.
    const workingActions = [...input.recordedActions];
    onEvent({ type: 'heal:browser', message: 'Replaying the recorded flow in a live browser…' });
    let brk: BreakPoint = await session.replayUntilBroken(workingActions);
    firstBreak = brk;
    let breakSummary = breakPhrase(brk);
    const parkedMsg = (b: BreakPoint, summary: string) =>
      `Replay parked at recorded step #${b.actionIndex} — ${summary}` + (b.brokenLocatorExpr ? `: ${b.brokenLocatorExpr}` : '');
    console.log(`[heal] ${parkedMsg(brk, breakSummary)}`);
    onEvent({ type: 'heal:browser', message: parkedMsg(brk, breakSummary) });
    const boundSession = session;

    // Bridges the recording-replay domain (brk / workingActions) into the
    // agentic fix session: re-parks the live browser when a later attempt's
    // failure has moved to a different step, and bakes each verified locator
    // back into the working recording so a future re-replay reflects it.
    const browserSupport: BrowserFixSupport = {
      session: boundSession,
      actionIndex: brk.actionIndex,
      brokenAction: brk.brokenAction,
      brokenLocatorExpr: brk.brokenLocatorExpr,
      breakSummary,
      resync: async (failureOutput: string) => {
        // The live browser stays parked wherever the FIRST replay left it —
        // if an earlier attempt's fix resolved that step and the real test
        // (run via runPlaywrightTest, not this simplified replay) now fails
        // somewhere else, the parked page is stale: probing it can report
        // "0 matches" for an element that simply hasn't been reached yet,
        // not one that's actually gone. Only re-sync on positive evidence
        // (a locator actually extracted from THIS run's failure, and it
        // doesn't match where we're parked) — never guess.
        const nowFailing = extractFailingLocator(failureOutput);
        if (!nowFailing || nowFailing === brk.brokenLocatorExpr) return null;
        console.log(`[heal] failure moved — re-syncing the live browser (was: ${brk.brokenLocatorExpr ?? '(none)'}, now: ${nowFailing})`);
        brk = await boundSession.replayUntilBroken(workingActions);
        breakSummary = breakPhrase(brk);
        const msg = `Failure moved to a different step — re-syncing the live browser… ${parkedMsg(brk, breakSummary)}`;
        console.log(`[heal] ${parkedMsg(brk, breakSummary)}`);
        return { message: msg, actionIndex: brk.actionIndex, brokenAction: brk.brokenAction, brokenLocatorExpr: brk.brokenLocatorExpr, breakSummary };
      },
      onVerifiedLocator: (locatorExpr, actionIndex) => {
        // Bake this fix into the working copy so a FUTURE re-replay (above)
        // reflects it instead of re-discovering the same original break.
        if (actionIndex < workingActions.length) {
          const action = workingActions[actionIndex];
          if (action.element) {
            workingActions[actionIndex] = { ...action, element: { ...action.element, suggestedLocator: locatorExpr } };
          }
        }
      },
    };

    deps = {
      run: (specFile) => runPlaywrightTest(specFile, signal),
      fix: (params) => runFixSession({ ...params, signal, browser: browserSupport }),
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
      maxAttempts: Math.max(0, Math.trunc(input.maxAttempts ?? MAX_HEAL_ATTEMPTS)),
      status: 'running',
      lastOutput: '',
      suspectedRealBug: false,
      attempt: 0,
      history: [],
    });
    return finalState;
  } finally {
    if (finalState && !depsOverride) recordRecovery(input, finalState, firstBreak, onEvent);
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
