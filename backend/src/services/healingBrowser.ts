// A single long-lived *headed* browser the self-heal agent drives to see what a
// failing test actually hits. Unlike testRunner.ts (a cold `npx playwright test`
// subprocess that only yields text), this keeps one Chromium open across the
// whole heal loop: the agent replays the recorded flow to the broken step, then
// probes the live DOM and tests candidate locators against the real page before
// committing a fix. Local-dev only — it launches a visible window on purpose.
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RecordedAction } from '../types.js';

const SLOW_MO_MS = 250;
// A heal run that gives up leaves the window open for manual takeover; close it
// after this long (or when the next run starts) so it can't leak forever.
const PARK_TIMEOUT_MS = 10 * 60_000;
const ARTIFACT_DIR = path.resolve('test-results', 'heal');
const SNAPSHOT_CHARS = 8000;
const HTML_CHARS = 4000;
const MAX_MATCH_DETAIL = 5;

export interface ProbeMatch {
  tag: string;
  text: string;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
}

export interface ProbeResult {
  expr: string;
  count: number;
  matches: ProbeMatch[];
  error?: string;
}

export interface BreakPoint {
  /** Index into the recorded actions of the first step whose locator no longer
   *  resolves to exactly one element. Equals actions.length when nothing broke. */
  actionIndex: number;
  brokenAction?: RecordedAction;
  brokenLocatorExpr?: string;
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

async function describeMatches(loc: Locator, count: number): Promise<ProbeMatch[]> {
  const out: ProbeMatch[] = [];
  for (let i = 0; i < Math.min(count, MAX_MATCH_DETAIL); i++) {
    const nth = loc.nth(i);
    const [tag, text, visible, box] = await Promise.all([
      nth.evaluate((el) => el.tagName.toLowerCase()).catch(() => '?'),
      nth.innerText().catch(() => ''),
      nth.isVisible().catch(() => false),
      nth.boundingBox().catch(() => null),
    ]);
    out.push({ tag, text: text.replace(/\s+/g, ' ').trim().slice(0, 120), visible, box });
  }
  return out;
}

export async function getSession(): Promise<HealingSession> {
  if (current) {
    console.log('[heal-browser] closing previous session before starting a new one');
    await current.teardown();
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  console.log('[heal-browser] launching headed Chromium (slowMo)');
  const browser = await chromium.launch({ headless: false, slowMo: SLOW_MO_MS });
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
        if (a.action === 'mark_step') continue;

        if (a.action === 'navigate') {
          try {
            if (!navigated) {
              await page.goto(a.url, { waitUntil: 'domcontentloaded' });
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
          await page.goto(a.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          navigated = true;
        }

        const expr = a.element?.suggestedLocator;
        if (!expr) {
          console.warn(`[heal-browser] replay step ${i} (${a.action}): no suggestedLocator, skipping`);
          continue;
        }

        // Probe BEFORE acting: the first step whose locator is not unique is the
        // break point, and the page is already parked right before it.
        const probe = await this.probeLocator(expr);
        if (probe.error || probe.count !== 1) {
          console.log(
            `[heal-browser] break at step ${i} (${a.action}) — ${expr} => ${probe.error ? `error: ${probe.error}` : `count=${probe.count}`}`
          );
          return { actionIndex: i, brokenAction: a, brokenLocatorExpr: expr };
        }

        try {
          const loc = buildLocator(page, expr);
          if (a.action === 'click') await loc.click({ timeout: 15000 });
          else if (a.action === 'input') await loc.fill(a.value ?? '', { timeout: 15000 });
          else if (a.action === 'select') await loc.selectOption(a.value ?? '', { timeout: 15000 });
        } catch (err) {
          // Locator was unique but the action still failed (detached, covered,
          // disabled…): treat this step as the break point too.
          console.log(`[heal-browser] break at step ${i} (${a.action}) — action failed: ${(err as Error).message}`);
          return { actionIndex: i, brokenAction: a, brokenLocatorExpr: expr };
        }
      }
      console.log(`[heal-browser] full replay succeeded; page parked at ${page.url()}`);
      return { actionIndex: actions.length };
    },

    async probeLocator(expr) {
      try {
        const loc = buildLocator(page, expr);
        const count = await loc.count();
        return { expr, count, matches: await describeMatches(loc, count) };
      } catch (err) {
        return { expr, count: 0, matches: [], error: (err as Error).message };
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
