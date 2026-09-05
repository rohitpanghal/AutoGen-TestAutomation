// Executes one generated spec file with Playwright and reports pass/fail plus
// enough of the failure output for an LLM to diagnose (error message, stack,
// strict-mode violation details — Playwright's "line" reporter includes these).
import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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

export async function runPlaywrightTest(specFile: string): Promise<TestRunResult> {
  // Playwright's CLI treats a positional file argument as a regex matched against
  // relative, POSIX-style test paths — not a literal filesystem path. An absolute
  // Windows path (backslashes, drive letter) never matches that regex, silently
  // producing "No tests found" instead of running the file. The basename alone
  // matches reliably since testDir already scopes the search to this folder.
  const fileArg = path.basename(specFile);
  const command = `npx playwright test "${fileArg}" --config generated-tests/playwright.config.ts --reporter=line`;
  console.log(`[runner] $ ${command}`);
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: RUN_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${stdout}\n${stderr}`.trim().slice(-MAX_OUTPUT_CHARS);
    console.log(`[runner] passed`);
    console.log(`----- runner OUTPUT -----\n${output}\n----- end runner OUTPUT -----`);
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = (`${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'Unknown Playwright failure').slice(-MAX_OUTPUT_CHARS);
    console.log(`[runner] failed`);
    console.log(`----- runner OUTPUT -----\n${output}\n----- end runner OUTPUT -----`);
    return { passed: false, output };
  }
}
