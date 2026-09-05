// Executes one generated spec file with Playwright and reports pass/fail plus
// enough of the failure output for an LLM to diagnose (error message, stack,
// strict-mode violation details — Playwright's "line" reporter includes these).
import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const MAX_OUTPUT_CHARS = 6000;
const RUN_TIMEOUT_MS = 60_000;

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
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: RUN_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { passed: true, output: `${stdout}\n${stderr}`.trim().slice(-MAX_OUTPUT_CHARS) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'Unknown Playwright failure';
    return { passed: false, output: output.slice(-MAX_OUTPUT_CHARS) };
  }
}
