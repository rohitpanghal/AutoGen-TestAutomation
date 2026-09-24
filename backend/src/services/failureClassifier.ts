// Turns a raw Playwright failure dump (plus, when available, the live-browser
// BreakPoint) into a typed, normalized FailureSignature. Pure and synchronous —
// no I/O — so the same signature can key the recovery store today and drive
// strategy selection later. Only ever describes a failure; never decides a fix.
import type { BreakPoint } from './healingBrowser.js';

// Pull the locator Playwright was actually stuck on out of a failure dump — the
// "waiting for <locator>" line of a timeout call log, or the subject of a
// strict-mode violation. This is ground truth for WHICH step broke; the replay
// parking point is only a hint and can be a false positive.
export function extractFailingLocator(output: string): string | undefined {
  const strict = output.match(/strict mode violation:\s+(.+?)\s+resolved to \d+ element/);
  if (strict) return strict[1].trim();
  const waiting = output.match(/waiting for\s+(.+?)\s*(?:\n|$)/);
  if (waiting) return waiting[1].trim();
  return undefined;
}

export type FailureKind =
  | 'locator-zero-match' // locator resolved to nothing (element gone / not rendered yet)
  | 'locator-ambiguous' // strict-mode violation: matched more than one element
  | 'locator-invalid' // the expression itself is malformed
  | 'action-failed' // one element found, but the action on it failed (covered, disabled, detached…)
  | 'assertion-mismatch' // an expect(...) ran and its value differed
  | 'navigation' // URL / page-load expectation not met
  | 'timeout' // timed out with no locator we can blame
  | 'unknown';

export type LocatorKind = 'testId' | 'role' | 'label' | 'text' | 'placeholder' | 'name' | 'css' | 'xpath' | 'unknown';

export interface FailureSignature {
  kind: FailureKind;
  locatorExpr?: string;
  locatorKind?: LocatorKind;
  matchCount?: number;
  visibleCount?: number;
  elementTag?: string;
  elementRole?: string;
  // origin + pathname of the step's page with id-like segments collapsed to
  // ":id", so /orders/123 and /orders/456 compare equal.
  urlPattern?: string;
  // Short, single-line excerpt of the actual error, for human inspection only —
  // not intended as a matching feature.
  errorSnippet: string;
}

export function locatorKindOf(expr: string | undefined): LocatorKind | undefined {
  if (!expr) return undefined;
  if (/getByTestId\(/.test(expr) || /data-testid/.test(expr)) return 'testId';
  if (/getByRole\(/.test(expr)) return 'role';
  if (/getByLabel\(/.test(expr)) return 'label';
  if (/getByPlaceholder\(/.test(expr)) return 'placeholder';
  if (/getByText\(/.test(expr)) return 'text';
  if (/\[name=/.test(expr)) return 'name';
  if (/locator\(\s*['"`](?:xpath=|\/\/)/.test(expr)) return 'xpath';
  if (/locator\(/.test(expr)) return 'css';
  return 'unknown';
}

export function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const segments = u.pathname
      .split('/')
      .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) ? ':id' : s));
    return `${u.origin}${segments.join('/')}`;
  } catch {
    return undefined;
  }
}

// First meaningful error line, ANSI stripped and length-capped.
function errorSnippet(output: string): string {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const line =
    clean.split('\n').map((l) => l.trim()).find((l) => /error|expect|timeout|strict mode|waiting for/i.test(l)) ??
    clean.trim().split('\n')[0] ??
    '';
  return line.slice(0, 240);
}

export function classifyFailure(output: string, brk?: BreakPoint): FailureSignature {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const locatorExpr = brk?.brokenLocatorExpr ?? extractFailingLocator(clean);
  const probe = brk?.brokenProbe;

  const sig: FailureSignature = {
    kind: 'unknown',
    locatorExpr,
    locatorKind: locatorKindOf(locatorExpr),
    matchCount: probe?.count,
    visibleCount: probe?.visibleCount,
    elementTag: brk?.brokenAction?.element?.tag,
    elementRole: brk?.brokenAction?.element?.role,
    urlPattern: normalizeUrl(brk?.brokenAction?.url),
    errorSnippet: errorSnippet(clean),
  };

  const strict = clean.match(/strict mode violation:.*?resolved to (\d+) element/s);
  if (strict) {
    sig.kind = 'locator-ambiguous';
    sig.matchCount ??= Number(strict[1]);
    return sig;
  }
  if (probe?.error || probe?.invalidExpression) {
    sig.kind = 'locator-invalid';
    return sig;
  }
  if (/toHaveURL|toHaveTitle|page\.goto|net::ERR|Navigation/.test(clean)) {
    sig.kind = 'navigation';
    return sig;
  }
  // Playwright prints the literal string "expect(locator)." for its own
  // web-first state assertions (toBeVisible/toBeEnabled/...) — distinct from
  // "expect(received)." / "expect(value)." for a plain value comparison. A
  // state assertion failing is a locator/timing problem (the element never
  // reached that state), not a mismatched value, regardless of exactly how
  // the "Received:" line phrases it — seen in practice: both a "not found"
  // and (evidently) some other non-"not found" wording reach here.
  const locatorStateAssertion = clean.match(
    /expect\(locator\)\.(?:not\.)?(toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|toBeAttached|toBeChecked|toBeEditable|toBeFocused|toBeInViewport|toBeEmpty)\(/
  );
  if (locatorStateAssertion) {
    if (/Received:\s*<?element\(s\) not found/i.test(clean)) {
      sig.kind = 'locator-zero-match';
    } else if (/Received:\s*hidden/i.test(clean)) {
      // Resolved to an element, just not in the required state.
      sig.kind = 'action-failed';
    } else {
      // Timed out without a legible "Received:" value — default to the more
      // common case (never appeared) rather than the rarer wrong-state case.
      sig.kind = 'locator-zero-match';
    }
    return sig;
  }
  if (/Expected:|Received:|expect\(.*\)\.(?:not\.)?to\w+/s.test(clean)) {
    sig.kind = 'assertion-mismatch';
    return sig;
  }
  if (
    brk?.actionError ||
    /not visible|not enabled|not editable|intercepts pointer events|detached from the DOM|element is outside/i.test(clean)
  ) {
    sig.kind = 'action-failed';
    return sig;
  }
  if (probe && probe.count === 0) {
    sig.kind = 'locator-zero-match';
    return sig;
  }
  if (probe && probe.count > 1) {
    sig.kind = 'locator-ambiguous';
    return sig;
  }
  if (locatorExpr && /Timeout \d+ms exceeded|Test timeout/.test(clean)) {
    // Timed out waiting on a locator and nothing says it matched something.
    sig.kind = 'locator-zero-match';
    return sig;
  }
  if (/Timeout \d+ms exceeded|Test timeout/.test(clean)) sig.kind = 'timeout';
  return sig;
}
