// Executes one generated spec file with Playwright and reports pass/fail plus
// enough of the failure output for an LLM to diagnose (error message, stack,
// strict-mode violation details — Playwright's "line" reporter includes these).
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { debugBlock } from './logging.js';

const execAsync = promisify(exec);

// Call the locally-installed Playwright CLI directly. `npx playwright` re-resolves
// the package on every invocation (~1-2s) and the heal loop runs it many times;
// the local bin skips that. Falls back to `npx playwright` if the bin is missing.
const LOCAL_PW_BIN = path.resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
);

const MAX_OUTPUT_CHARS = 6000;
// Must stay comfortably above generated-tests/playwright.config.ts's own test
// timeout (90_000ms) — otherwise this wrapper's exec timeout kills the process
// before Playwright's internal timeout fires, so the failure never gets
// reported and the self-heal loop diagnoses off an empty error.
const RUN_TIMEOUT_MS = 120_000;

export interface TestRunResult {
  passed: boolean;
  output: string;
}

export async function runPlaywrightTest(specFile: string, signal?: AbortSignal): Promise<TestRunResult> {
  if (signal?.aborted) return { passed: false, output: 'Cancelled before the Playwright run started.' };
  // Playwright's CLI treats a positional file argument as a regex matched against
  // relative, POSIX-style test paths — not a literal filesystem path. An absolute
  // Windows path (backslashes, drive letter) never matches that regex, silently
  // producing "No tests found" instead of running the file. The basename alone
  // matches reliably since testDir already scopes the search to this folder.
  const fileArg = path.basename(specFile);
  const runner = existsSync(LOCAL_PW_BIN) ? `"${LOCAL_PW_BIN}"` : 'npx playwright';
  const command = `${runner} test "${fileArg}" --config generated-tests/playwright.config.ts --reporter=line`;
  console.log(`[runner] $ ${command}`);
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: RUN_TIMEOUT_MS,
      // HEAL_RUN tells generated-tests/playwright.config.ts to drop video capture
      // (the priciest per-test artifact) for these throwaway loop runs; a manual
      // `npm run test:generated` has no such flag and keeps full artifacts.
      env: { ...process.env, HEAL_RUN: '1' },
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    const output = `${stdout}\n${stderr}`.trim().slice(-MAX_OUTPUT_CHARS);
    console.log(`[runner] passed`);
    debugBlock('runner OUTPUT', output);
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = (`${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'Unknown Playwright failure').slice(-MAX_OUTPUT_CHARS);
    console.log(`[runner] failed`);
    debugBlock('runner OUTPUT', output);
    return { passed: false, output };
  }
}
