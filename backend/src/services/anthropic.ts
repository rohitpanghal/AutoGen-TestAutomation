// Combines the "Test Designer" and "Code Generator" roles into one structured call:
// fewer handoffs, one place to tune prompting, cheaper than two round trips.
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { RecordedAction, GeneratedTestCase } from '../types.js';
import type { HealingSession } from './healingBrowser.js';
import { debugBlock } from './logging.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Single source of truth for the model id (was inline in four places).
const MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = `You are a QA engineer AI. You receive a raw list of browser actions recorded by a Chrome extension (clicks, inputs, selects, navigations, file-input uploads, semantically meaningful key presses, and manual "mark_step" markers the user inserted to indicate logical step boundaries). Your job:

1. Group actions between mark_step markers (and the start/end of the list) into logical test steps. Use the marker's label if provided. An "action":"note" entry is NOT a boundary — keep it inside the current step.
2. Write a human-readable test case: title, preconditions, steps, and expected results. Be conservative about expected results — only assert things directly supported by the recorded actions (e.g. a navigation, a visible element clicked) OR explicitly requested in a user "description" (see below). Do not invent outcomes you cannot justify from either source.
3. Generate a single Playwright TypeScript test (using @playwright/test) that reproduces the steps.

Assertions — the code must not be a bare click-replay. Every string in "expectedResults" and every non-empty step "expectedResult" is a claim you are making about the app's behavior, and every such claim MUST be backed by a real "expect(...)" call in playwrightCode that verifies it — never write an expected result in the testCase JSON without emitting the assertion that checks it. If a step has nothing justified to assert, leave its expectedResult empty rather than writing a claim with no code behind it; keep applying the existing conservatism rule (only assert what the recording or a user description actually supports — do not invent outcomes). Concretely, ground assertions in what you already have:
- Navigation: alongside the existing "await page.waitForURL(...)" placement rule below, immediately follow it with "await expect(page).toHaveURL(...)" using the same pathname, so the navigation is a real assertion and not just an implicit wait.
- First interaction on a page after a navigation or a mark_step boundary: before acting on that step's target element, add "await expect(<its locator>).toBeVisible()". This is always justified — the recording proves the element existed because the user went on to interact with it — so treat it as a default, not an exception.
- A "note" step, or a step whose "description" names a specific outcome: implement it as a real assertion per the "User-authored intent" rules below (unchanged).
- Anything else with no grounded signal: do not assert it.

User-authored intent — after recording, the user reviews the action list and may attach a "description" string to any action, and may insert standalone steps with "action":"note" (these have no recorded element, no suggestedLocator, and exist only to carry an instruction). A description is the user's explicit statement of what that step is meant to do or verify, written with product knowledge you do not have from the raw events. Treat it as authoritative:
- It overrides your own inference about the step's purpose. Reflect its wording in the corresponding test-case step.
- It frequently asks for an assertion or comparison that is NOT a literal recorded event — e.g. "check that every visible table row's SKU column contains the text just typed into the search box". Implement exactly that as real Playwright assertions (expect(...)), iterating with count()/nth()/for-loops or toHaveText([...]) as needed. Do not settle for replaying the nearby click — produce the verification the user asked for.
- It can also pin down WHICH element a step acts on when the recorded event alone is ambiguous — "the 1st visible Proceed button", "within the 'Warehouse Ace' card", "the row whose Status is Active". When it does, the locator you emit for that step MUST satisfy it, and the description overrides the SHAPE of suggestedLocator (though not its verified leaf strategy): (a) any text the description puts in quotes must appear verbatim in the emitted locator — as the hasText / name / getByText argument — never paraphrased, never replaced with a similar-looking value seen elsewhere in the DOM; (b) an ordinal ("1st", "2nd", "last") becomes .first() / .nth(n) / .last(), applied after .filter({ visible: true }) when the description says "visible"; (c) "within X" / "in the X card/row/section" becomes .filter({ hasText: 'X' }) (or a scope through X) wrapping suggestedLocator's leaf. Reconcile: start from suggestedLocator's leaf, then apply the description's scoping and indexing on top. If suggestedLocator and the description clearly point at different target elements, the description wins.
- For an "action":"note" step, implement the instruction in sequence at its position in the flow. Derive whatever locators it needs using the same priority order below, keyed off neighbouring actions' elements when helpful.
- If a description contradicts the raw event (e.g. "this button should NOT navigate away"), follow the description and encode it as the assertion.

Selectors — each action's element includes a precomputed "suggestedLocator": a ready-to-use Playwright locator expression string (e.g. "page.getByRole('button', { name: 'Login' })" or, for an element that collided with a duplicate elsewhere on the page, something like "page.locator('li').filter({ hasText: 'Change Password Logout' }).locator('#dropdownMenuLink')"). This was computed deterministically from the DOM at recording time, already accounts for uniqueness (duplicate ids, ambiguous role+text matches get scoped through a container or landmark), and is more reliable than anything you can derive yourself from the raw element fields. Use it verbatim: copy the expression and append the appropriate action call (.click(), .fill(value), .selectOption(value), etc). Do not re-derive your own selector from element.css, element.id, element.role, etc. when suggestedLocator is present — treat those raw fields as debugging context only. The one exception is when the step's "description" pins down which element to target (see "User-authored intent" above): keep suggestedLocator's verified leaf but reshape its scoping/indexing to match the description, and preserve verbatim any string the description quotes. A suggestedLocator may end with ".filter({ visible: true })" — this guards against a hidden DOM duplicate (e.g. a responsive desktop/mobile nav pair, only one ever on-screen); keep it, it is load-bearing, not a stylistic choice to simplify away. It may also be a "page.locator('xpath=//...')" expression — this only happens when the app gave the recorder nothing better to hook into (no testid, no stable class anywhere up the tree, ambiguous role+text), and the xpath itself is text-anchored (verified unique at record time), not a fragile index path; keep it as-is. Only fall back to deriving a selector yourself (getByTestId > getByRole > getByLabel > getByText > page.locator(css)) in the rare case suggestedLocator is missing — prefer any of those over writing your own xpath, since you cannot verify uniqueness the way the recorder did. One override to that order: for a form control (input / select / textarea, other than a radio or checkbox) that has a "name" attribute, prefer page.locator('select[name="…"]') / page.locator('input[name="…"]') over getByText or a getByRole('combobox', { name: … }) whose name would just be the field's concatenated option list — the name attribute is smaller and far more stable than that text.

Frames — an element captured inside an iframe carries an "element.frame" object. When suggestedLocator is present, it already includes the necessary "page.frameLocator('…').frameLocator('…')…" chain (same-origin iframe, computed and verified the same deterministic way as every other suggestedLocator) — use it verbatim like any other. When "element.frame.crossOrigin" is true, suggestedLocator is deliberately absent — the recorder cannot reach into a cross-origin frame to compute or verify a selector for it, so nothing here is a fact you can trust. In that case, build "page.frameLocator(<best-effort selector>)" yourself from "element.frame.frameUrl" (e.g. an iframe[src*="…"] guess using a distinctive part of that URL) chained with a leaf derived from the raw element fields (role/text/label per the priority order above), explicitly state in that step's description that the frame locator is unverified because the frame is cross-origin, and do not add an expectedResult for that step — you cannot justify a claim you cannot verify.

Waiting — never use page.waitForTimeout or any arbitrary sleep. Playwright locators auto-wait for actionability, so a normal "await page.getByRole(...).click()" already waits for the element. The one case that needs an explicit wait is an action immediately followed by a "navigate" action in the recording — that action caused a navigation (a full page load AND an SPA route change are both recorded as "navigate"). After THAT specific action, and only that one, add "await page.waitForURL('**' + pathname)" using the path of the navigate action's url (leading "**" then the pathname, e.g. "**/bookappointments"), before interacting with anything on the new page.
Placement is strict: tie the wait to the action the "navigate" immediately follows — NOT to whichever click "looks like" the navigating one (a login / submit / "Proceed" button), and NOT just because that url appears somewhere else in the recording. Cross-check with the "url" field: every action carries the url of the page it happened on. If action N and action N+1 share the same "url" and no "navigate" sits between them, nothing navigated there — no wait. If their "url" values differ (even with no "navigate" action recorded between them, e.g. an older recording), treat action N as having navigated to N+1's url and add the waitForURL after N. For an async UI change that did NOT change the url and produced no "navigate" action (a modal opening, an inline panel swap), do not add a manual wait — let the next locator's auto-wait handle it; use "await expect(locator).toBeVisible()" only where the test is specifically asserting that something appeared.
One targeted exception for form submits: when a single click submits a form that the immediately preceding steps filled (a Save / Submit / Create button right after a run of fill / selectOption calls), the app often re-renders that button on each field commit and can detach it mid-click. For THAT click only, emit: first "await page.locator('input[name=\"…\"]').blur()" on the last field the test filled (commit its onChange re-render before the click), then issue the click through a re-resolving retry — "await expect(async () => { await <buttonLocator>.click({ timeout: 5000 }); }).toPass({ timeout: 30000 });". Do not wrap ordinary mid-flow clicks this way; only the form-submitting one.

Values — every "input"/"select" action's "value" field is the real, literal value that was recorded (recording no longer masks anything). Use it verbatim in the generated fill/selectOption call. Never invent, guess, or paraphrase a value that isn't present in the recorded actions.

Uploads — an "upload" action recorded a "change" on a file input. Browsers never expose a file input's real path to page JavaScript, so the recorder could only capture the filename (in "value") as a label, not a usable path. If the action also carries a non-empty "filePath" (the user filled it in on the review screen), emit "await <locator>.setInputFiles('<filePath>')" using it verbatim — never invent or guess a path yourself, and never use the "value" filename as if it were a path. If "filePath" is empty or absent, emit a comment instead of a fill call — "// TODO: set a real file path for this upload (recorded filename: "<value>")" — and leave that step's expectedResult empty.

Key presses — a "keydown" action recorded a semantically meaningful key press (its "value" is one of "Enter", "Escape", "Tab", "Shift+Tab") on the focused element, captured separately from "input"/"select" because it commits no field value of its own. Emit "await <locator>.press('<value>')" using the value verbatim — it is already in Playwright's .press() key-string format. A "keydown" participates in the navigate-adjacency waitForURL rule exactly like a click: if it's immediately followed by a "navigate" action, add the wait after it (e.g. an Enter that submits a form and navigates).

Respond ONLY by calling the emit_test tool.`;

const TOOL = {
  name: 'emit_test',
  description: 'Emit the generated test case and Playwright code.',
  input_schema: {
    type: 'object',
    properties: {
      testCase: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          preconditions: { type: 'array', items: { type: 'string' } },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                expectedResult: {
                  type: 'string',
                  description:
                    'If non-empty, this claim MUST be implemented as a real expect(...) call in playwrightCode. Leave empty if there is nothing grounded to assert for this step.',
                },
              },
              required: ['description'],
            },
          },
          expectedResults: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Each entry MUST have a corresponding expect(...) assertion in playwrightCode that verifies it — do not list an expected result without emitting the code that checks it.',
          },
        },
        required: ['title', 'preconditions', 'steps', 'expectedResults'],
      },
      playwrightCode: {
        type: 'string',
        description: 'Full contents of a .spec.ts file using @playwright/test.',
      },
    },
    required: ['testCase', 'playwrightCode'],
  },
} as const;

export async function generateTest(
  testName: string,
  actions: RecordedAction[],
  opts: { signal?: AbortSignal } = {}
): Promise<{ testCase: GeneratedTestCase; playwrightCode: string }> {
  // Pure token-cost trim: locatorCandidates is the review page's full list of
  // locator options (for QA to pick from), never something the model needs —
  // suggestedLocator already reflects whichever one was chosen (default or
  // QA's override), so this array would just be dead weight in the prompt.
  const promptActions = actions.map((a) =>
    a.element?.locatorCandidates ? { ...a, element: { ...a.element, locatorCandidates: undefined } } : a
  );
  const userContent = `Test name: ${testName}\n\nRecorded actions (JSON):\n${JSON.stringify(promptActions, null, 2)}`;
  console.log(`[anthropic] emit_test request — model=${MODEL}, ${actions.length} actions`);
  debugBlock('anthropic emit_test INPUT', userContent);

  const message = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'tool', name: 'emit_test' },
      messages: [{ role: 'user', content: userContent }],
    },
    { signal: opts.signal }
  );
  console.log(`[anthropic] emit_test response — stop_reason=${message.stop_reason}, tokens in=${message.usage.input_tokens} out=${message.usage.output_tokens}`);

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    console.error('[anthropic] emit_test: model did not return a tool_use block');
    debugBlock('anthropic emit_test RAW response content', message.content);
    throw new Error('Model did not return structured output.');
  }
  const output = toolUse.input as { testCase: GeneratedTestCase; playwrightCode: string };
  debugBlock('anthropic emit_test OUTPUT', output);
  return output;
}

const FIX_GUIDANCE = `You are debugging a failing Playwright test that was auto-generated from a recorded user flow. You are given the original test case description, the current test code, and the Playwright failure output (error message, stack trace, strict-mode violation details, etc).

Diagnose the failure and produce a corrected version of the full test file. Likely causes, in rough order: (1) a selector that resolves to more than one element (strict mode violation) — if one of the matches is hidden/not visible (e.g. a responsive desktop/mobile duplicate, a collapsed accordion, an inactive tab), fix it by appending .filter({ visible: true }) to that locator, not .first()/.last()/.nth() — index-based picks are a coin flip that breaks again the moment DOM order changes, while a visible-only filter states the actual intent ("the one the user can see") and stays correct regardless of order; if instead every match is genuinely visible, that's a real ambiguity — fix it with a more specific role/name, a data-testid, or by scoping through a stable ancestor with .filter({ hasText: ... }); for an ambiguous form control (input / select / textarea, not a radio/checkbox), reach for page.locator('select[name="…"]') / page.locator('input[name="…"]') before any text-based locator — the name attribute is stabler than a <select>'s visible-text (its whole option list) and than a nearby label; (2) a click that resolved to an element that is present in the DOM but never becomes visible — this is usually the same hidden-duplicate situation as (1), not a timing problem, so prefer the visible filter over adding a wait; (3) a missing wait after an action that triggers navigation — add page.waitForURL(...), never a fixed sleep; (4) the application's actual behavior no longer matches what was recorded — this is not a test bug; (5) the target IS visible and the click starts, but the failure output says "element is not stable", "element was detached from the DOM, retrying", or the click times out inside its own retry loop — this is a re-render race, NOT a hidden duplicate and NOT an app regression: an onChange / async-validation handler on a field filled by an earlier step keeps rebuilding the subtree, so the resolved node is destroyed before the click lands. Fix it with both of: (a) commit the previously filled field so its re-render happens before this action, not during it — await page.locator('input[name="…"]').blur() (or a Tab press) on the last field the test filled; (b) wrap ONLY the flaky action in a re-resolving retry so a mid-click detach re-resolves the locator instead of failing: await expect(async () => { await <locator>.click({ timeout: 5000 }); }).toPass({ timeout: 30000 }); — and add await expect(<locator>).toBeEnabled() first if the button also toggles disabled while the form settles. If the app exposes a concrete settle signal (a specific validation response, a spinner leaving the DOM), await that too. Never use page.waitForTimeout. The locator itself is correct here — do not change it, and set verifiedLocator to "".

Invariants — do not paraphrase your way out of a failure. Any string that appears quoted in the test-case step or in that step's user intent, and any hasText / name / getByText / getByRole-name literal already present in the current (broken) locator, is a value you must keep. Fixing a locator by swapping one of these literals for a different one you found on the page (e.g. changing filter({ hasText: 'Warehouse Ace' }) to filter({ hasText: 'Ace Hardware' })) is never correct — it silently retargets the test. If no locator that preserves every such literal resolves to exactly one element, the app itself changed (a card renamed or removed, a label reworded): set likelyRealBug to true, leave the code unchanged, and name the literal that no longer matches in the diagnosis.

Make the smallest change that fixes the root cause. Do not weaken or delete an assertion just to make the test pass. Do not "fix" a locator by dropping scoping that was there for a reason (a container .filter({ hasText }) / .filter({ visible: true }) chain) just because a shorter bare locator happens to be unique on the page right now — repair the segment that actually broke and keep the chain. If the failure output shows the application genuinely did something different from what the recording expected (not a selector or timing problem), that is a real regression, not a broken test: set likelyRealBug to true, leave the code's logic and assertions unchanged, and explain what changed in the diagnosis. Never use page.waitForTimeout.`;

const FIX_SYSTEM_PROMPT = `${FIX_GUIDANCE}

Respond ONLY by calling the emit_fix tool.`;

const FIX_SYSTEM_PROMPT_BROWSER = `${FIX_GUIDANCE}

You have a LIVE headed browser parked on the page exactly as it is right before the failing step. Verify against it — do not guess:
- try_locator({ expr }): read-only — evaluates a "page.*" locator against the live page (never clicks or fills; that's advance). Returns count (Playwright strict mode counts hidden matches too), visibleCount, and up to 5 matches in DOM order — each with tag / role / testId / id / ariaLabel / text / visible / inViewport / enabled, plus scopeHint (the nearest ancestor with a testId or a meaningful class, and its text). Use scopeHint to rebuild a SCOPED locator (ancestor.filter({ hasText }) then the leaf) rather than collapsing a broken chain to a bare getByText. truncated = matches not shown; invalidExpression = the expr itself is malformed, so count/matches mean nothing. THIS IS YOUR MAIN TOOL.
- aria_snapshot({ scopeExpr? }): the accessibility tree of the whole page, or of the subtree matched by scopeExpr.
- get_html({ expr, n? }): outerHTML of the first n matches (default 2) of a locator expression.
- advance({ kind, expr, value? }): click / fill / select on the live page, to move one step further along if the failure only reproduces after more interaction.
- screenshot({ label }): capture the current page.

Which step actually failed: the Playwright failure output is authoritative. The "replayed to recorded action #N" parking point is only a hint and is sometimes a false positive — most often a not-yet-hydrated SPA reporting 0 matches for the very first locator, which then resolves fine. If the parked locator probes as count === 1 and looks healthy, do not keep hunting it: pivot to the locator named in the Playwright call log / error output and fix that one.

Workflow: first reproduce the problem — call try_locator on the locator from the Playwright failure output (falling back to the parked-step locator) and confirm the match count. If it reports count > 1 but visibleCount === 1, the fix is just to append .filter({ visible: true }) to that same locator — do not switch to a different or shorter one. If the failure output says "element is not stable" or "element was detached from the DOM, retrying" and try_locator shows that same locator at count === 1, visible and enabled, stop probing — the locator is fine, this is a re-render race (cause 5): leave the locator unchanged, set verifiedLocator to "", and in the code blur/commit the previously filled field and wrap only the failing action in await expect(async () => { await <locator>.click({ timeout: 5000 }); }).toPass({ timeout: 30000 }). If the failing locator matches 0 elements and no candidate that preserves every required literal can match exactly one, that is a real app regression — set likelyRealBug true, name the literal that no longer matches, and leave the code unchanged. Otherwise iterate candidate locators with try_locator until one matches EXACTLY ONE element, preferring the recorder's priority order: getByTestId > getByRole with name > getByLabel > getByText > a locator scoped through a stable ancestor with .filter({ hasText }) or .filter({ visible: true }). Exception for form controls (input / select / textarea, excluding radio/checkbox): try page.locator('select[name="…"]') / page.locator('input[name="…"]') right after getByTestId and before any role-name or text strategy — for a <select> especially, getByRole('combobox', { name: … }) drags in the entire option list as the name and is far more brittle than the name attribute. When the failing locator is a scoped chain (ancestor .filter(...) then a leaf), keep the scoping: fix the segment that actually broke, don't replace the whole chain with a bare leaf that only happens to be unique on this page right now — use each match's scopeHint to find the ancestor to scope through. Only once you have seen count === 1 for your replacement, call emit_fix with that exact expression in verifiedLocator. If the failure is a genuine app regression, set likelyRealBug true, leave the code unchanged, and set verifiedLocator to "".`;

const FIX_TOOL = {
  name: 'emit_fix',
  description: 'Emit a diagnosis and a corrected Playwright test. Call only after verifying the replacement locator with try_locator (count === 1), or when the failure is a real app regression.',
  input_schema: {
    type: 'object',
    properties: {
      diagnosis: { type: 'string', description: 'What went wrong and why, in 1-3 sentences.' },
      likelyRealBug: {
        type: 'boolean',
        description:
          'True if the failure looks like a genuine application regression (the recorded expectation is correct and the app now behaves differently), rather than a fragile/incorrect selector or a timing issue.',
      },
      updatedPlaywrightCode: {
        type: 'string',
        description: 'The full corrected .spec.ts file contents (unchanged from the input if likelyRealBug is true).',
      },
      verifiedLocator: {
        type: 'string',
        description:
          'The exact "page.*" locator expression you confirmed matches exactly one element via try_locator. Use "" only when the fix is not a locator change (e.g. only added waitForURL) or when likelyRealBug is true.',
      },
    },
    required: ['diagnosis', 'likelyRealBug', 'updatedPlaywrightCode', 'verifiedLocator'],
  },
} as const;

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  name,
  description,
  input_schema: { type: 'object', properties, required },
});

const BROWSER_TOOLS = [
  tool(
    'try_locator',
    'Run a "page.*" Playwright locator expression against the live page and report how many elements it matches and what they are.',
    { expr: { type: 'string', description: 'e.g. page.getByRole(\'button\', { name: \'Logout\' })' } },
    ['expr']
  ),
  tool(
    'aria_snapshot',
    'Accessibility tree of the live page, or of the subtree matched by scopeExpr.',
    { scopeExpr: { type: 'string', description: 'Optional "page.*" locator to scope the snapshot.' } },
    []
  ),
  tool(
    'get_html',
    'outerHTML of the first n matches of a "page.*" locator expression.',
    { expr: { type: 'string' }, n: { type: 'number', description: 'Default 2.' } },
    ['expr']
  ),
  tool(
    'advance',
    'Perform one action on the live page to move further along the flow.',
    {
      kind: { type: 'string', enum: ['click', 'fill', 'select'] },
      expr: { type: 'string', description: '"page.*" locator expression.' },
      value: { type: 'string', description: 'Required for fill / select.' },
    },
    ['kind', 'expr']
  ),
  tool('screenshot', 'Capture the current live page as a PNG.', { label: { type: 'string' } }, ['label']),
  FIX_TOOL,
] as unknown as Anthropic.Tool[];

export interface FixResult {
  diagnosis: string;
  likelyRealBug: boolean;
  updatedPlaywrightCode: string;
  verifiedLocator?: string;
}

export interface FixContext {
  session: HealingSession;
  brokenAction?: RecordedAction;
  brokenLocatorExpr?: string;
  actionIndex: number;
  // Human phrasing of *why* the replay parked ("locator matched 0 elements at
  // replay time", "locator matched 3 elements", "action failed: …"). Replaces
  // the old hard-coded "no longer resolves to exactly one visible element",
  // which was frequently false — a not-yet-hydrated SPA parks at step 0.
  breakSummary?: string;
}

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

const MAX_FIX_ITERATIONS = 8;

// Public entry point. With a FixContext, runs the live-DOM verification agent;
// without one, falls back to the original single text-only call (used by callers
// / tests that have no browser).
export async function fixTest(
  testCase: GeneratedTestCase,
  code: string,
  failureOutput: string,
  ctx?: FixContext,
  signal?: AbortSignal
): Promise<FixResult> {
  return ctx
    ? fixTestWithBrowser(testCase, code, failureOutput, ctx, signal)
    : fixTestTextOnly(testCase, code, failureOutput, signal);
}

async function fixTestTextOnly(
  testCase: GeneratedTestCase,
  code: string,
  failureOutput: string,
  signal?: AbortSignal
): Promise<FixResult> {
  const userContent = `Test case:\n${JSON.stringify(testCase, null, 2)}\n\nCurrent code:\n${code}\n\nPlaywright failure output:\n${failureOutput}`;
  console.log(`[anthropic] emit_fix request — model=${MODEL}, failure output ${failureOutput.length} chars`);
  debugBlock('anthropic emit_fix INPUT', userContent);

  const message = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 4096,
      system: FIX_SYSTEM_PROMPT,
      tools: [FIX_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'tool', name: 'emit_fix' },
      messages: [{ role: 'user', content: userContent }],
    },
    { signal }
  );
  console.log(`[anthropic] emit_fix response — stop_reason=${message.stop_reason}, tokens in=${message.usage.input_tokens} out=${message.usage.output_tokens}`);

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    console.error('[anthropic] emit_fix: model did not return a tool_use block');
    debugBlock('anthropic emit_fix RAW response content', message.content);
    throw new Error('Model did not return structured output.');
  }
  const fix = toolUse.input as FixResult;
  console.log(`[anthropic] diagnosis: ${fix.diagnosis} (likelyRealBug=${fix.likelyRealBug})`);
  debugBlock('anthropic emit_fix OUTPUT', fix);
  return fix;
}

async function runBrowserTool(
  session: HealingSession,
  t: Anthropic.ToolUseBlock,
  trail: string[]
): Promise<{ text: string; image?: Anthropic.ImageBlockParam }> {
  try {
    if (t.name === 'try_locator') {
      const { expr } = t.input as { expr: string };
      const probe = await session.probeLocator(expr);
      trail.push(
        `try ${expr} -> ${
          probe.error
            ? `err(${probe.error})`
            : `count=${probe.count}${probe.visibleCount !== probe.count ? ` (vis=${probe.visibleCount})` : ''}`
        }`
      );
      return { text: JSON.stringify(probe, null, 2) };
    }
    if (t.name === 'aria_snapshot') {
      const { scopeExpr } = t.input as { scopeExpr?: string };
      return { text: await session.ariaSnapshot(scopeExpr) };
    }
    if (t.name === 'get_html') {
      const { expr, n } = t.input as { expr: string; n?: number };
      return { text: await session.outerHtml(expr, n) };
    }
    if (t.name === 'advance') {
      const { kind, expr, value } = t.input as { kind: 'click' | 'fill' | 'select'; expr: string; value?: string };
      trail.push(`advance ${kind} ${expr}`);
      return { text: await session.advance(kind, expr, value) };
    }
    if (t.name === 'screenshot') {
      const { label } = t.input as { label?: string };
      const file = await session.screenshot(label ?? 'shot');
      const data = readFileSync(file).toString('base64');
      return {
        text: `screenshot saved: ${file}`,
        image: { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      };
    }
    return { text: `unknown tool ${t.name}` };
  } catch (err) {
    return { text: `tool ${t.name} error: ${(err as Error).message}` };
  }
}

async function fixTestWithBrowser(
  testCase: GeneratedTestCase,
  code: string,
  failureOutput: string,
  ctx: FixContext,
  signal?: AbortSignal
): Promise<FixResult> {
  const { session, brokenAction, brokenLocatorExpr, actionIndex, breakSummary } = ctx;
  // The per-action user intent, if the reviewer attached one. It carries the
  // literals ("Warehouse Ace", "1st visible", …) the fix must preserve, so pass
  // it explicitly rather than making the agent hunt for the matching step in
  // the testCase JSON.
  const intentLine = brokenAction?.description
    ? `\n\nUser intent for that step (authoritative — every quoted string in it is a value you may NOT change):\n${brokenAction.description}`
    : '';
  const failingFromOutput = extractFailingLocator(failureOutput);
  // The parked step and the step Playwright actually failed on can differ (a
  // false-positive park, or the failure is further along). When the failure
  // output names a locator, say so explicitly and point the agent at it.
  const authoritativeNote = failingFromOutput
    ? `\n\nThe authoritative Playwright run failed while waiting on this locator — this is ground truth for WHICH step is broken. Trust it over the parking point above (which can be a false positive, e.g. a not-yet-hydrated SPA on the first step):\n${failingFromOutput}`
    : '';
  const brokenContext = brokenLocatorExpr
    ? `\n\nThe live browser was replayed to recorded action #${actionIndex} (${brokenAction?.action}). Parking reason: ${breakSummary ?? 'locator did not resolve to exactly one element'}.\nParked-step locator:\n${brokenLocatorExpr}${intentLine}${authoritativeNote}\n\nRecorded element descriptor for that action:\n${JSON.stringify(brokenAction?.element ?? {}, null, 2)}`
    : `\n\nThe replay reached recorded action #${actionIndex} without a locator breaking; the failure is likely an assertion or timing issue at or after that point. The live browser is parked there.${intentLine}${authoritativeNote}`;

  const userContent = `Test case:\n${JSON.stringify(testCase, null, 2)}\n\nCurrent code:\n${code}\n\nPlaywright failure output:\n${failureOutput}${brokenContext}`;
  console.log(`[anthropic] emit_fix (browser agent) — model=${MODEL}, failure output ${failureOutput.length} chars`);
  debugBlock('anthropic emit_fix INPUT', userContent);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];
  const trail: string[] = [];

  for (let iter = 1; iter <= MAX_FIX_ITERATIONS; iter++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 8192,
        system: FIX_SYSTEM_PROMPT_BROWSER,
        tools: BROWSER_TOOLS,
        messages,
      },
      { signal }
    );
    console.log(
      `[anthropic] fix iter ${iter}/${MAX_FIX_ITERATIONS} — stop_reason=${message.stop_reason}, tokens in=${message.usage.input_tokens} out=${message.usage.output_tokens}`
    );
    messages.push({ role: 'assistant', content: message.content });

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    if (toolUses.length === 0) {
      messages.push({
        role: 'user',
        content: 'Call a tool: keep probing with try_locator, or call emit_fix once you have a verified fix.',
      });
      continue;
    }

    const emit = toolUses.find((t) => t.name === 'emit_fix');
    if (emit) {
      const candidate = emit.input as FixResult;
      let rejectReason = '';
      if (!candidate.likelyRealBug && candidate.verifiedLocator && candidate.verifiedLocator.trim()) {
        const expr = candidate.verifiedLocator.trim();
        const probe = await session.probeLocator(expr);
        trail.push(
          `verify ${expr} -> count=${probe.count}${probe.visibleCount !== probe.count ? ` (vis=${probe.visibleCount})` : ''}`
        );
        if (probe.count !== 1) {
          const hint =
            probe.visibleCount === 1
              ? ' Exactly one match is visible — append .filter({ visible: true }) to this locator instead of choosing a different one.'
              : '';
          rejectReason = `verifiedLocator "${expr}" matches ${probe.count} element(s), need exactly 1.${hint} Matches: ${JSON.stringify(probe.matches)}. Keep iterating with try_locator.`;
        }
      }
      if (!rejectReason) {
        const result: FixResult = {
          diagnosis: trail.length ? `${candidate.diagnosis} [probe trail: ${trail.join(' | ')}]` : candidate.diagnosis,
          likelyRealBug: Boolean(candidate.likelyRealBug),
          updatedPlaywrightCode: candidate.updatedPlaywrightCode,
          verifiedLocator: candidate.verifiedLocator,
        };
        console.log(`[anthropic] diagnosis: ${result.diagnosis} (likelyRealBug=${result.likelyRealBug})`);
        debugBlock('anthropic emit_fix OUTPUT', result);
        return result;
      }
      messages.push({
        role: 'user',
        content: toolUses.map((t) => ({
          type: 'tool_result' as const,
          tool_use_id: t.id,
          content: t.id === emit.id ? rejectReason : 'superseded — emit_fix was rejected, continue.',
          is_error: t.id === emit.id,
        })),
      });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const { text, image } = await runBrowserTool(session, t, trail);
      results.push({
        type: 'tool_result',
        tool_use_id: t.id,
        content: image ? [image, { type: 'text', text }] : text,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  console.warn('[anthropic] fix agent hit the iteration cap without a verified emit_fix');
  return {
    diagnosis: `Heal agent could not converge on a verified fix within ${MAX_FIX_ITERATIONS} iterations. Probe trail: ${trail.join(' | ') || '(none)'}`,
    likelyRealBug: false,
    updatedPlaywrightCode: code,
  };
}
