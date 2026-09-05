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

const HealState = Annotation.Root({
  testCase: Annotation<GeneratedTestCase>({ reducer: (_prev, next) => next, default: () => ({} as GeneratedTestCase) }),
  code: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  specFile: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  scratchFile: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  attempt: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  maxAttempts: Annotation<number>({ reducer: (_prev, next) => next, default: () => 5 }),
  status: Annotation<'running' | 'passed' | 'failed'>({ reducer: (_prev, next) => next, default: () => 'running' }),
  lastOutput: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  suspectedRealBug: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
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

const defaultDeps: HealingGraphDeps = { run: runPlaywrightTest, fix: fixTest };

function buildGraph(deps: HealingGraphDeps) {
  async function runNode(state: HealStateType): Promise<Partial<HealStateType>> {
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
    const history = state.history.slice();
    if (history.length > 0) {
      history[history.length - 1] = { ...history[history.length - 1], diagnosis: result.diagnosis };
    }
    return {
      code: result.updatedPlaywrightCode,
      attempt: state.attempt + 1,
      suspectedRealBug: result.likelyRealBug,
      history,
    };
  }

  function routeAfterFix(state: HealStateType): 'run' | typeof END {
    if (state.suspectedRealBug) {
      console.log(`[heal] fix flagged as a likely real app bug — stopping without retrying`);
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

  // Build the live-browser fixer deps unless the caller injected their own
  // (tests) or gave us no recording to replay.
  let session: HealingSession | undefined;
  let deps = depsOverride ?? defaultDeps;
  if (!depsOverride && input.recordedActions?.length) {
    session = await getSession();
    const brk: BreakPoint = await session.replayUntilBroken(input.recordedActions);
    console.log(
      `[heal] replay parked at action #${brk.actionIndex}` +
        (brk.brokenLocatorExpr ? ` — broken locator: ${brk.brokenLocatorExpr}` : ' — no locator broke (assertion/timing)')
    );
    const boundSession = session;
    deps = {
      run: runPlaywrightTest,
      fix: (testCase, code, failureOutput) =>
        fixTest(testCase, code, failureOutput, {
          session: boundSession,
          brokenAction: brk.brokenAction,
          brokenLocatorExpr: brk.brokenLocatorExpr,
          actionIndex: brk.actionIndex,
        }),
    };
  }

  const graph = buildGraph(deps);
  let finalState: HealStateType | undefined;
  try {
    finalState = await graph.invoke({
      testCase: input.testCase,
      code: input.code,
      specFile: input.specFile,
      scratchFile,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 5,
      status: 'running',
      lastOutput: '',
      suspectedRealBug: false,
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
