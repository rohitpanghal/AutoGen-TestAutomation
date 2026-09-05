// A single long-lived browser the self-heal agent drives to see what a failing
// test actually hits. Unlike testRunner.ts (a cold `npx playwright test`
// subprocess that only yields text), this keeps one Chromium open across the
// whole heal loop: the agent replays the recorded flow to the broken step, then
// probes the live DOM and tests candidate locators against the real page before
// committing a fix. Headless by default for speed; set HEAL_HEADED=1 to get a
// visible window (and slowMo) so a human can watch and take over a give-up.
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RecordedAction } from '../types.js';

// A visible window is only useful when someone is actually watching (HEAL_HEADED);
// slowMo then makes the replay followable. In the default headless heal loop both
// are pure latency — a 7-step replay plus the fix agent's probes is dozens of
// Playwright ops, and 250ms each added up to seconds of doing nothing.
const HEADED = process.env.HEAL_HEADED === '1';
const SLOW_MO_MS = HEADED ? Math.max(0, Math.trunc(Number(process.env.HEAL_SLOW_MO)) || 250) : 0;
// A heal run that gives up leaves the window open for manual takeover; close it
// after this long (or when the next run starts) so it can't leak forever.
const PARK_TIMEOUT_MS = 10 * 60_000;
// A locator that matches nothing the instant we look — right after a navigation
// — is usually just a not-yet-hydrated SPA, not a real break. Give it this long
// to attach before ruling the step broken. The real spec's auto-waiting
// .fill()/.click() would wait up to the 90s test timeout here, so even 15s is
// far less patient — it just covers a cold Amplify/Lambda start + bundle
// execute without stalling the loop for genuinely-gone elements. A count > 1
// (genuine ambiguity) skips this grace. Override with HEAL_REPLAY_SETTLE_MS.
const SETTLE_TIMEOUT_MS = Math.max(0, Math.trunc(Number(process.env.HEAL_REPLAY_SETTLE_MS)) || 15_000);
const ARTIFACT_DIR = path.resolve('test-results', 'heal');
const SNAPSHOT_CHARS = 8000;
const HTML_CHARS = 4000;
const MAX_MATCH_DETAIL = 5;

export interface ProbeMatch {
  tag: string;
  role?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
  // innerText, falling back to textContent when the element renders nothing
  // (a display:none responsive duplicate) so the match isn't a blank row the
  // fixer can't identify. Capped at 120 chars.
  text: string;
  // Playwright's own visibility answer — what strict mode and
  // `.filter({ visible: true })` actually key off.
  visible: boolean;
  // Visible AND within the current viewport rect. A visible element scrolled
  // off-screen still reports inViewport: false.
  inViewport: boolean;
  // Not disabled / aria-disabled — lets the fixer separate "wrong element"
  // from "right element, not interactable yet".
  enabled: boolean;
  // Nearest ancestor carrying a data-testid or a non-utility class, plus that
  // ancestor's trimmed text — the same thing the recorder's getContainerHint
  // computes. Handing it to the fixer lets it rebuild a scoped locator
  // (ancestor >> leaf) instead of collapsing a broken chain to a bare
  // page.getByText(...).
  scopeHint?: { selector: string; text: string };
  box: { x: number; y: number; width: number; height: number } | null;
}

export interface ProbeResult {
  expr: string;
  count: number;
  // Of `count`, how many are visible right now. `count > 1 && visibleCount === 1`
  // is the exact signal that appending `.filter({ visible: true })` makes the
  // locator unique (responsive desktop/mobile pair, collapsed panel, inactive tab).
  visibleCount: number;
  matches: ProbeMatch[];
  // count - matches.length: matches past the MAX_MATCH_DETAIL cap that aren't
  // detailed here. 0 when every match is described.
  truncated: number;
  // Set when `expr` is not a valid Playwright locator expression at all (syntax
  // error, or it doesn't evaluate to a Locator). Distinct from a valid
  // expression that legitimately matches zero elements — do not read this as
  // "the element is gone".
  invalidExpression?: boolean;
  error?: string;
}

export interface BreakPoint {
  /** Index into the recorded actions of the first step whose locator no longer
   *  resolves to exactly one element. Equals actions.length when nothing broke. */
  actionIndex: number;
  brokenAction?: RecordedAction;
  brokenLocatorExpr?: string;
  /** The probe of `brokenLocatorExpr` that triggered the break, so callers can
   *  describe it accurately (matched 0 / matched N / errored) instead of
   *  assuming "no longer unique". Absent when nothing broke, or when the break
   *  was an action failure (see `actionError`). */
  brokenProbe?: ProbeResult;
  /** Set when the locator DID resolve to exactly one element but performing the
   *  recorded action against it still failed (detached, covered, disabled…). */
  actionError?: string;
}

export interface HealingSession {
  readonly page: Page;
  /** Single forward pass: replay each recorded action, but before performing a
   *  locator action first probe its locator. Stop at the first one that doesn't
   *  resolve to exactly one element — the page is then parked right before it. */
  replayUntilBroken(actions: RecordedAction[]): Promise<BreakPoint>;
  /** The verification primitive: how many elements does `expr` match right now,
   *  and what are they. `expr` must be a `page.*` Playwright locator expression. */
  probeLocator(expr: string): Promise<ProbeResult>;
  ariaSnapshot(scopeExpr?: string): Promise<string>;
  outerHtml(expr: string, n?: number): Promise<string>;
  /** Perform one action against the live page (to reach a state further along). */
  advance(kind: 'click' | 'fill' | 'select', expr: string, value?: string): Promise<string>;
  screenshot(label: string): Promise<string>;
  /** Keep the window open after teardown() would normally run (give-up path). */
  park(): void;
  teardown(): Promise<void>;
}

interface InternalSession extends HealingSession {
  _browser: Browser;
  _context: BrowserContext;
  _parked: boolean;
  _parkTimer: NodeJS.Timeout | null;
}

let current: InternalSession | null = null;

// The generated locator strings (and the agent's candidates) are always
// `page.getByRole(...)` / `page.locator(...)` expressions. They're our own
// output run against our own machine, so eval-ing them is acceptable here;
// never expose this path to untrusted input.
function buildLocator(page: Page, expr: string): Locator {
  const trimmed = expr.trim().replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func
  const fn = new Function('page', `return (${trimmed});`) as (p: Page) => Locator;
  const loc = fn(page);
  if (!loc || typeof (loc as Locator).count !== 'function') {
    throw new Error(`Expression did not evaluate to a Playwright Locator: ${expr}`);
  }
  return loc;
}

// One in-page evaluate collects everything DOM-derivable about a match: its
// identity attributes, rendered text (with a textContent fallback so a
// display:none duplicate isn't a blank row), whether it's in the viewport, and
// the nearest ancestor a scoped locator could hang off. isVisible/boundingBox
// stay as Playwright calls in describeMatches because they answer with
// Playwright's own semantics, which is what the generated locator is judged by.
async function describeMatch(nth: Locator): Promise<Omit<ProbeMatch, 'visible' | 'box'>> {
  const fallback: Omit<ProbeMatch, 'visible' | 'box'> = {
    tag: '?',
    text: '',
    inViewport: false,
    enabled: true,
  };
  const dom = await nth
    .evaluate((node) => {
      const el = node as HTMLElement;
      const UTIL =
        /^(?:d-|flex\b|w-\d|h-\d|m[trblxy]?-?\d|p[trblxy]?-?\d|f-\d|fs-\d|btn(?:-|$)|active$|show$|hide$|hidden$|col(?:-|$)|row$|container(?:-|$)|text-|bg-|border|justify-|align-|position-|float-)/i;
      const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const meaningfulClass = (n: Element): string | undefined => {
        for (const c of Array.from(n.classList)) {
          if (c.length > 2 && !UTIL.test(c)) return c;
        }
        return undefined;
      };
      let scopeHint: { selector: string; text: string } | undefined;
      let anc: Element | null = el.parentElement;
      let depth = 0;
      while (anc && anc !== document.body && depth < 8) {
        const tid = anc.getAttribute('data-testid');
        const cls = meaningfulClass(anc);
        if (tid || cls) {
          scopeHint = {
            selector: tid ? `[data-testid="${tid}"]` : `.${cls}`,
            text: norm((anc as HTMLElement).innerText || anc.textContent).slice(0, 80),
          };
          break;
        }
        anc = anc.parentElement;
        depth++;
      }
      const rendered = norm(el.innerText) || norm(el.textContent);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        testId: el.getAttribute('data-testid') || undefined,
        id: el.id || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        text: rendered.slice(0, 120),
        enabled: !(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'),
        inViewport:
          r.width > 0 &&
          r.height > 0 &&
          r.top < window.innerHeight &&
          r.bottom > 0 &&
          r.left < window.innerWidth &&
          r.right > 0,
        scopeHint,
      };
    })
    .catch(() => null);
  return dom ?? fallback;
}

async function describeMatches(loc: Locator, count: number): Promise<ProbeMatch[]> {
  const out: ProbeMatch[] = [];
  for (let i = 0; i < Math.min(count, MAX_MATCH_DETAIL); i++) {
    const nth = loc.nth(i);
    const [dom, visible, box] = await Promise.all([
      describeMatch(nth),
      nth.isVisible().catch(() => false),
      nth.boundingBox().catch(() => null),
    ]);
    out.push({ ...dom, visible, box });
  }
  return out;
}

export async function getSession(): Promise<HealingSession> {
  if (current) {
    console.log('[heal-browser] closing previous session before starting a new one');
    await current.teardown();
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  console.log(`[heal-browser] launching Chromium (headless=${!HEADED}, slowMo=${SLOW_MO_MS})`);
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOW_MO_MS });
  const context = await browser.newContext();
  const page = await context.newPage();

  const session: InternalSession = {
    _browser: browser,
    _context: context,
    _parked: false,
    _parkTimer: null,
    page,

    async replayUntilBroken(actions) {
      let navigated = false;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        // Neither is a real DOM interaction — 'mark_step' is a grouping label,
        // 'note' is a review-time instruction the generator consumed. Nothing to
        // replay in the live browser.
        if (a.action === 'mark_step' || a.action === 'note') continue;

        if (a.action === 'navigate') {
          try {
            if (!navigated) {
              // 'load', not 'domcontentloaded': the latter fires before the JS
              // bundle executes, so on an SPA the first probe races an empty
              // #root and false-parks on step 1. 'load' waits for the bundle;
              // the SETTLE grace below then covers React's first render.
              await page.goto(a.url, { waitUntil: 'load' });
              navigated = true;
            } else {
              // Later navigations are usually click side effects (SPA route
              // changes); don't re-goto and blow away app state — just settle.
              await page.waitForURL(a.url, { timeout: 5000 }).catch(() => {});
            }
          } catch (err) {
            console.warn(`[heal-browser] replay nav ${i} failed (continuing): ${(err as Error).message}`);
          }
          continue;
        }

        if (!navigated) {
          await page.goto(a.url, { waitUntil: 'load' }).catch(() => {});
          navigated = true;
        }

        const expr = a.element?.suggestedLocator;
        if (!expr) {
          console.warn(`[heal-browser] replay step ${i} (${a.action}): no suggestedLocator, skipping`);
          continue;
        }

        // Probe BEFORE acting: the first step whose locator is not unique is the
        // break point, and the page is already parked right before it.
        let probe = await this.probeLocator(expr);
        // count === 0 the moment we look is usually a not-yet-hydrated SPA
        // (goto only waited for domcontentloaded), not a real break — give the
        // locator one chance to attach, then re-probe. count > 1 is a genuine
        // ambiguity now and does not get the grace period.
        if (!probe.error && probe.count === 0) {
          await buildLocator(page, expr)
            .first()
            .waitFor({ state: 'attached', timeout: SETTLE_TIMEOUT_MS })
            .catch(() => {});
          probe = await this.probeLocator(expr);
        }
        if (probe.error || probe.count !== 1) {
          console.log(
            `[heal-browser] break at step ${i} (${a.action}) — ${expr} => ${probe.error ? `error: ${probe.error}` : `count=${probe.count}`}`
          );
          return { actionIndex: i, brokenAction: a, brokenLocatorExpr: expr, brokenProbe: probe };
        }

        try {
          const loc = buildLocator(page, expr);
          if (a.action === 'click') await loc.click({ timeout: 15000 });
          else if (a.action === 'input') await loc.fill(a.value ?? '', { timeout: 15000 });
          else if (a.action === 'select') await loc.selectOption(a.value ?? '', { timeout: 15000 });
        } catch (err) {
          // Locator was unique but the action still failed (detached, covered,
          // disabled…): treat this step as the break point too.
          const actionError = (err as Error).message;
          console.log(`[heal-browser] break at step ${i} (${a.action}) — action failed: ${actionError}`);
          return { actionIndex: i, brokenAction: a, brokenLocatorExpr: expr, actionError };
        }
      }
      console.log(`[heal-browser] full replay succeeded; page parked at ${page.url()}`);
      return { actionIndex: actions.length };
    },

    async probeLocator(expr) {
      let loc: Locator;
      try {
        loc = buildLocator(page, expr);
      } catch (err) {
        // Malformed expression — flag it distinctly so the fixer doesn't read a
        // syntax error as "that element no longer exists".
        return {
          expr,
          count: 0,
          visibleCount: 0,
          matches: [],
          truncated: 0,
          invalidExpression: true,
          error: (err as Error).message,
        };
      }
      try {
        const count = await loc.count();
        const [visibleCount, matches] = await Promise.all([
          count === 0 ? Promise.resolve(0) : loc.filter({ visible: true }).count().catch(() => 0),
          describeMatches(loc, count),
        ]);
        return { expr, count, visibleCount, matches, truncated: Math.max(0, count - matches.length) };
      } catch (err) {
        return { expr, count: 0, visibleCount: 0, matches: [], truncated: 0, error: (err as Error).message };
      }
    },

    async ariaSnapshot(scopeExpr) {
      try {
        const loc = scopeExpr ? buildLocator(page, scopeExpr) : page.locator('body');
        const snap = await loc.ariaSnapshot();
        return snap.length > SNAPSHOT_CHARS ? `${snap.slice(0, SNAPSHOT_CHARS)}\n… (truncated)` : snap;
      } catch (err) {
        return `aria_snapshot failed: ${(err as Error).message}`;
      }
    },

    async outerHtml(expr, n = 2) {
      try {
        const loc = buildLocator(page, expr);
        const count = await loc.count();
        if (count === 0) return `(no elements match ${expr})`;
        const parts: string[] = [];
        for (let i = 0; i < Math.min(count, n); i++) {
          const html = await loc.nth(i).evaluate((el) => el.outerHTML).catch(() => '(unavailable)');
          parts.push(html.length > HTML_CHARS ? `${html.slice(0, HTML_CHARS)}… (truncated)` : html);
        }
        return `${count} match(es); showing ${parts.length}:\n${parts.join('\n---\n')}`;
      } catch (err) {
        return `get_html failed: ${(err as Error).message}`;
      }
    },

    async advance(kind, expr, value) {
      const loc = buildLocator(page, expr);
      if (kind === 'click') await loc.click({ timeout: 15000 });
      else if (kind === 'fill') await loc.fill(value ?? '', { timeout: 15000 });
      else await loc.selectOption(value ?? '', { timeout: 15000 });
      return `${kind} ok; page now at ${page.url()}`;
    },

    async screenshot(label) {
      const safe = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'shot';
      const file = path.join(ARTIFACT_DIR, `${Date.now()}-${safe}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    },

    park() {
      this._parked = true;
      if (this._parkTimer) clearTimeout(this._parkTimer);
      this._parkTimer = setTimeout(() => {
        console.log('[heal-browser] park timeout reached — closing');
        void this.teardown();
      }, PARK_TIMEOUT_MS);
      console.log('[heal-browser] session PARKED — window left open at the failing step for manual takeover');
    },

    async teardown() {
      if (this._parkTimer) clearTimeout(this._parkTimer);
      if (current === this) current = null;
      await this._context.close().catch(() => {});
      await this._browser.close().catch(() => {});
      console.log('[heal-browser] session closed');
    },
  };

  current = session;
  return session;
}
