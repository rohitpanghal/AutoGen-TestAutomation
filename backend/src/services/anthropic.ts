// Combines the "Test Designer" and "Code Generator" roles into one structured call:
// fewer handoffs, one place to tune prompting, cheaper than two round trips.
import Anthropic from '@anthropic-ai/sdk';
import type { RecordedAction, GeneratedTestCase } from '../types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a QA engineer AI. You receive a raw list of browser actions recorded by a Chrome extension (clicks, inputs, selects, navigations, and manual "mark_step" markers the user inserted to indicate logical step boundaries). Your job:

1. Group actions between mark_step markers (and the start/end of the list) into logical test steps. Use the marker's label if provided.
2. Write a human-readable test case: title, preconditions, steps, and expected results. Be conservative about expected results — only assert things directly supported by the recorded actions (e.g. a navigation, a visible element clicked). Do not invent outcomes you cannot justify from the data.
3. Generate a single Playwright TypeScript test (using @playwright/test) that reproduces the steps.

Selectors — each action's element includes a precomputed "suggestedLocator": a ready-to-use Playwright locator expression string (e.g. "page.getByRole('button', { name: 'Login' })" or, for an element that collided with a duplicate elsewhere on the page, something like "page.locator('li').filter({ hasText: 'Change Password Logout' }).locator('#dropdownMenuLink')"). This was computed deterministically from the DOM at recording time, already accounts for uniqueness (duplicate ids, ambiguous role+text matches get scoped through a container or landmark), and is more reliable than anything you can derive yourself from the raw element fields. Use it verbatim: copy the expression and append the appropriate action call (.click(), .fill(value), .selectOption(value), etc). Do not re-derive your own selector from element.css, element.id, element.role, etc. when suggestedLocator is present — treat those raw fields as debugging context only. Only fall back to deriving a selector yourself (getByTestId > getByRole > getByLabel > getByText > page.locator(css), never xpath) in the rare case suggestedLocator is missing.

Waiting — never use page.waitForTimeout or any arbitrary sleep. Playwright locators auto-wait for actionability, so a normal "await page.getByRole(...).click()" already waits for the element. The one case that needs an explicit wait is a click immediately followed by a "navigate" action in the recording (the click caused a full page navigation): after that click, add "await page.waitForURL(...)" (match the recorded URL, or a stable substring of it) before interacting with anything on the new page. For an async UI change with no recorded navigation (e.g. a modal opening, an SPA route change), do not add a manual wait — let the next locator's auto-wait handle it; use "await expect(locator).toBeVisible()" only where the test is specifically asserting that something appeared.

Any action with "masked": true represents a sensitive value (password, token, etc). Never output the literal value. Instead reference an environment variable, e.g. process.env.TEST_PASSWORD, and add a short comment noting it must be set.

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
                expectedResult: { type: 'string' },
              },
              required: ['description'],
            },
          },
          expectedResults: { type: 'array', items: { type: 'string' } },
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
  actions: RecordedAction[]
): Promise<{ testCase: GeneratedTestCase; playwrightCode: string }> {
  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'emit_test' },
    messages: [
      {
        role: 'user',
        content: `Test name: ${testName}\n\nRecorded actions (JSON):\n${JSON.stringify(actions, null, 2)}`,
      },
    ],
  });

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Model did not return structured output.');
  }
  return toolUse.input as { testCase: GeneratedTestCase; playwrightCode: string };
}

const FIX_SYSTEM_PROMPT = `You are debugging a failing Playwright test that was auto-generated from a recorded user flow. You are given the original test case description, the current test code, and the Playwright failure output (error message, stack trace, strict-mode violation details, etc).

Diagnose the failure and produce a corrected version of the full test file. Likely causes, in rough order: (1) a selector that no longer matches, or matches more than one element — fix with a more specific role/name, a data-testid, or by scoping through a stable ancestor with .filter({ hasText: ... }); prefer this over .first()/.nth(); (2) a missing wait after an action that triggers navigation — add page.waitForURL(...), never a fixed sleep; (3) the application's actual behavior no longer matches what was recorded — this is not a test bug.

Make the smallest change that fixes the root cause. Do not weaken or delete an assertion just to make the test pass. If the failure output shows the application genuinely did something different from what the recording expected (not a selector or timing problem), that is a real regression, not a broken test: set likelyRealBug to true, leave the code's logic and assertions unchanged, and explain what changed in the diagnosis. Never use page.waitForTimeout.

Respond ONLY by calling the emit_fix tool.`;

const FIX_TOOL = {
  name: 'emit_fix',
  description: 'Emit a diagnosis and a corrected Playwright test.',
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
    },
    required: ['diagnosis', 'likelyRealBug', 'updatedPlaywrightCode'],
  },
} as const;

export interface FixResult {
  diagnosis: string;
  likelyRealBug: boolean;
  updatedPlaywrightCode: string;
}

export async function fixTest(testCase: GeneratedTestCase, code: string, failureOutput: string): Promise<FixResult> {
  const message = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: FIX_SYSTEM_PROMPT,
    tools: [FIX_TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'emit_fix' },
    messages: [
      {
        role: 'user',
        content: `Test case:\n${JSON.stringify(testCase, null, 2)}\n\nCurrent code:\n${code}\n\nPlaywright failure output:\n${failureOutput}`,
      },
    ],
  });

  const toolUse = message.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Model did not return structured output.');
  }
  return toolUse.input as FixResult;
}
