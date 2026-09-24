// Structural gate a candidate .spec.ts file must pass before it's trusted
// enough to execute or persist: valid TypeScript syntax, plus the two things
// every Playwright spec needs to be more than dead code (the @playwright/test
// import, at least one test() call). Without this, a truncated rewrite or a
// dropped import from the fix session only ever surfaced as an opaque
// Playwright launch failure burning a real attempt — or, worse, as that same
// broken file silently persisted to the user's real spec once the heal loop
// ran out of attempts. Pure and synchronous — no I/O.
import ts from 'typescript';

export interface ScriptValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSpecCode(code: string): ScriptValidationResult {
  const errors: string[] = [];

  if (!code.trim()) {
    return { valid: false, errors: ['File is empty.'] };
  }

  const result = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  for (const d of result.diagnostics ?? []) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file && d.start !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      errors.push(`line ${line + 1}: ${message}`);
    } else {
      errors.push(message);
    }
  }

  if (!/from\s+['"]@playwright\/test['"]/.test(code)) {
    errors.push(`Missing "import { test, expect } from '@playwright/test'" — file has no Playwright import.`);
  }
  if (!/\btest(?:\.\w+)?\s*\(/.test(code)) {
    errors.push('No test(...) call found — file defines no actual test.');
  }

  return { valid: errors.length === 0, errors };
}
