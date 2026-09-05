// Self-healing loop: run the generated spec, and if it fails, ask Claude to
// diagnose + patch it, then run again — until it passes, a fix claims the
// failure is a real app regression (retrying identical code would be pointless),
// or maxAttempts is exhausted. LangGraph owns the run/fix/retry control flow;
// the nodes themselves are thin wrappers around the existing runner + LLM call.
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { runPlaywrightTest } from './testRunner.js';
import { fixTest, type FixResult } from './anthropic.js';
import type { GeneratedTestCase } from '../types.js';
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
  attempt: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  maxAttempts: Annotation<number>({ reducer: (_prev, next) => next, default: () => 3 }),
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
    const result = await deps.run(state.specFile);
    return {
      lastOutput: result.output,
      status: result.passed ? 'passed' : 'failed',
      history: [...state.history, { attempt: state.attempt, passed: result.passed, output: result.output }],
    };
  }

  function routeAfterRun(state: HealStateType): 'fix' | typeof END {
    if (state.status === 'passed') return END;
    if (state.attempt >= state.maxAttempts) return END;
    return 'fix';
  }

  async function fixNode(state: HealStateType): Promise<Partial<HealStateType>> {
    const result = await deps.fix(state.testCase, state.code, state.lastOutput);
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
    return state.suspectedRealBug ? END : 'run';
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
}

export async function healTest(input: HealInput, deps: HealingGraphDeps = defaultDeps): Promise<HealStateType> {
  const graph = buildGraph(deps);
  return graph.invoke({
    testCase: input.testCase,
    code: input.code,
    specFile: input.specFile,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    status: 'running',
    lastOutput: '',
    suspectedRealBug: false,
    history: [],
  });
}
