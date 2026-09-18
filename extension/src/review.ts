// Post-recording review & annotation page. The popup opens this in a tab right
// after STOP_RECORDING. It loads the recording from chrome.storage.local
// ('lastRecording', written by the background worker on stop), lets the user:
//   - fix input/select values and step-marker labels
//   - attach a plain-language "description" (intent) to any step
//   - delete stray steps and reorder them
//   - insert description-only "note" steps for checks that were never a recorded
//     DOM event ("compare the visible table rows against the search input", ...)
// "Generate test" POSTs the edited action list to /api/generate and navigates to
// the run page. The backend prompt (backend/src/services/anthropic.ts) treats a
// step's description as the authoritative statement of what that step must do.

const REVIEW_API_BASE = 'http://localhost:4000';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const nameInput = byId<HTMLInputElement>('test-name');
const listEl = byId<HTMLOListElement>('steps');
const emptyEl = byId<HTMLParagraphElement>('empty');
const countEl = byId<HTMLSpanElement>('count');
const generateBtn = byId<HTMLButtonElement>('generate-btn');
const closeButton = byId<HTMLButtonElement>('close-btn');
const addNoteEndBtn = byId<HTMLButtonElement>('add-note-end');
const alertBox = byId<HTMLDivElement>('alert');

// The working copy — source of truth for the page. Text edits write straight
// into it; structural changes (move / delete / insert) mutate it and re-render.
let actions: RecordedAction[] = [];
let testName = '';
// Set when this page was opened as "Create a variant from this flow"
// (?fromRecording=<id> — see run.ts) — sent back to /api/generate as pure
// traceability, not used for anything else here.
let parentId: string | undefined;

// A step QA is in the middle of inserting: type + (for input/select) a value,
// chosen before picking the target element on the live page. Not part of
// `actions` until the pick resolves — render() draws it as an extra row right
// after `afterIndex`.
let pendingInsert: { afterIndex: number; type: 'click' | 'input' | 'select'; value: string } | null = null;

// Element picker plumbing — background.ts opens/focuses a live tab and tells
// its content script to enter pick mode; the picked element comes back via
// chrome.storage.local's `pendingPick` key (content.ts can't message this
// page directly, it isn't a tab). requestId lets more than one pick be
// registered without a stale result resolving the wrong handler.
const pickHandlers = new Map<string, (element: ElementDescriptor, url: string) => void>();

// Which pick (if any) the "Picking…" alert's Cancel button applies to. Only
// one pick is ever in flight from this page in practice, but tracked by id
// rather than assumed so a resolved/cancelled pick can't stomp a newer one.
let activePickRequestId: string | undefined;

function startPick(url: string | undefined, onPicked: (element: ElementDescriptor, url: string) => void) {
  const requestId = crypto.randomUUID();
  pickHandlers.set(requestId, onPicked);
  chrome.runtime.sendMessage({ type: 'START_PICK', requestId, url });
  showPickingAlert(requestId);
}

// A pick session can now last a while (QA may browse around before arming —
// see content.ts), so unlike the plain showAlert() this needs a way back out
// without switching tabs: Cancel here does the same thing as the in-page
// banner's own Cancel button.
function showPickingAlert(requestId: string) {
  activePickRequestId = requestId;
  alertBox.innerHTML = '';
  alertBox.className = 'alert info';
  alertBox.appendChild(
    document.createTextNode(
      'Picking… switch to the opened tab, browse to where the element is, click "Target next click", then click it (Esc there to cancel). '
    )
  );
  alertBox.appendChild(
    miniBtn('Cancel', 'Cancel this pick', () => {
      pickHandlers.delete(requestId);
      chrome.runtime.sendMessage({ type: 'CANCEL_PICK', requestId });
      if (activePickRequestId === requestId) activePickRequestId = undefined;
      clearAlert();
    })
  );
  alertBox.hidden = false;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pendingPick?.newValue) return;
  const pick = changes.pendingPick.newValue as { requestId: string; element: ElementDescriptor; url: string };
  const handler = pickHandlers.get(pick.requestId);
  if (!handler) return;
  pickHandlers.delete(pick.requestId);
  chrome.storage.local.remove('pendingPick');
  if (activePickRequestId === pick.requestId) activePickRequestId = undefined;
  clearAlert();
  handler(pick.element, pick.url);
});

function showAlert(msg: string, variant?: 'info') {
  alertBox.textContent = msg;
  alertBox.className = variant ? `alert ${variant}` : 'alert';
  alertBox.hidden = false;
}

function clearAlert() {
  alertBox.hidden = true;
}

function summarize(a: RecordedAction): string {
  switch (a.action) {
    case 'navigate':
      return `Navigate to ${a.url}`;
    case 'mark_step':
      return a.label ? `Step marker: ${a.label}` : 'Step marker';
    case 'note':
      return 'Instruction — no recorded event';
    default: {
      const el = a.element;
      const target =
        el?.text || el?.ariaLabel || el?.testId || el?.role || el?.id || el?.tag || 'element';
      return `${a.action}${a.value ? ` “${a.value}”` : ''} — ${target}`;
    }
  }
}

function newNote(description = ''): RecordedAction {
  return { action: 'note', timestamp: Date.now(), url: '', description };
}

// Quick-insert starting point for the "does the search actually filter?"
// assertion — the single most common thing this kind of check needs.
// Deliberately says "the text just typed" rather than a hardcoded term: the
// backend prompt (anthropic.ts SYSTEM_PROMPT, point 22) already treats that
// phrasing as a pointer back to the real recorded input value, not a literal
// string to search for. Fully editable before generating, same as any other
// note.
const SEARCH_RESULTS_TEMPLATE =
  "If any results are visible, assert that every visible result row contains the text just typed into the search box. If there are zero visible results, assert that a \"no results\" message is shown instead.";

function miniBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mini';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const l = document.createElement('label');
  l.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  l.append(span, control);
  return l;
}

function textControl(value: string, onInput: (v: string) => void): HTMLInputElement {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value;
  inp.addEventListener('input', () => onInput(inp.value));
  return inp;
}

function move(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= actions.length) return;
  [actions[i], actions[j]] = [actions[j], actions[i]];
  render();
}

function remove(i: number) {
  actions.splice(i, 1);
  render();
}

function insertNoteAfter(i: number, description = '') {
  actions.splice(i + 1, 0, newNote(description));
  render();
  focusDesc(i + 1);
}

function focusDesc(i: number) {
  listEl.querySelectorAll<HTMLTextAreaElement>('.desc-input')[i]?.focus();
}

// The locator that would actually be used right now: QA's override if set,
// else whichever candidate content.ts marked isDefault (its best guess at
// what buildLeaf would auto-pick server-side — see
// backend/src/services/locatorBuilder.ts).
function effectiveLocator(el: ElementDescriptor): string {
  const override = el.locatorOverride?.trim();
  if (override) return override;
  return el.locatorCandidates?.find((c) => c.isDefault)?.expr ?? '(no locator captured)';
}

// Locator visibility + override, per step. Deliberately avoids calling the
// page-level render() on every keystroke in the custom-locator input (that
// would tear down and rebuild the whole list, dropping focus and collapsing
// every <details>) — instead it patches just the "current locator" chip
// directly, the same non-destructive pattern the description textarea and
// Value field already use for their own onInput handlers.
function buildLocatorSection(i: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'locator-section';

  const current = document.createElement('div');
  current.className = 'locator-current';
  current.appendChild(document.createTextNode('Locator: '));
  const codeEl = document.createElement('code');
  current.appendChild(codeEl);
  const overrideTag = document.createElement('span');
  overrideTag.className = 'locator-override-tag';
  overrideTag.textContent = 'QA override';
  current.appendChild(overrideTag);
  wrap.appendChild(current);

  const refreshCurrent = () => {
    const el = actions[i].element!;
    codeEl.textContent = effectiveLocator(el);
    overrideTag.hidden = !el.locatorOverride?.trim();
  };
  refreshCurrent();

  const details = document.createElement('details');
  details.className = 'locator-details';
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = 'Locator options';
  details.appendChild(summaryEl);

  const candidates = actions[i].element!.locatorCandidates ?? [];
  if (candidates.length > 0) {
    const list = document.createElement('ul');
    list.className = 'locator-candidates';
    candidates.forEach((c) => {
      const row = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'locator-kind';
      kind.textContent = c.kind;
      const exprEl = document.createElement('code');
      exprEl.textContent = c.expr;
      const count = document.createElement('span');
      count.className = c.count === 1 ? 'locator-count' : 'locator-count ambiguous';
      count.textContent = `${c.count} match${c.count === 1 ? '' : 'es'}`;
      const useBtn = miniBtn('Use', `Use this ${c.kind} locator`, () => {
        actions[i].element = { ...actions[i].element!, locatorOverride: c.expr };
        customInput.value = c.expr;
        refreshCurrent();
      });
      useBtn.classList.add('locator-use');
      row.append(kind, exprEl, count, useBtn);
      list.appendChild(row);
    });
    details.appendChild(list);
  } else {
    const none = document.createElement('p');
    none.className = 'hint';
    none.textContent = 'No automatic candidates for this element — type one below.';
    details.appendChild(none);
  }

  const customInput = textControl(actions[i].element!.locatorOverride ?? '', (v) => {
    actions[i].element = { ...actions[i].element!, locatorOverride: v || undefined };
    refreshCurrent();
  });
  customInput.placeholder = 'Full Playwright expression, e.g. page.getByRole(\'button\', { name: \'Submit\' }) — used verbatim';
  details.appendChild(field('Custom locator (advanced)', customInput));

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'link-add';
  resetBtn.textContent = 'Reset to automatic';
  resetBtn.addEventListener('click', () => {
    const { locatorOverride, ...rest } = actions[i].element!;
    actions[i].element = rest;
    customInput.value = '';
    refreshCurrent();
  });
  details.appendChild(resetBtn);

  wrap.appendChild(details);
  return wrap;
}

function buildRow(a: RecordedAction, i: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'step';

  const head = document.createElement('div');
  head.className = 'step-head';

  const badge = document.createElement('span');
  badge.className = `badge badge-${a.action}`;
  badge.textContent = a.action;

  const summary = document.createElement('span');
  summary.className = 'summary';
  summary.textContent = summarize(a);
  summary.title = summarize(a);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const up = miniBtn('↑', 'Move up', () => move(i, -1));
  const down = miniBtn('↓', 'Move down', () => move(i, 1));
  const del = miniBtn('✕', 'Delete step', () => remove(i));
  up.disabled = i === 0;
  down.disabled = i === actions.length - 1;

  head.append(badge, summary, spacer);
  // Retarget: point this step at a different live element instead of hand-
  // editing a selector string. Only meaningful for a step that recorded one.
  if (a.element) {
    head.appendChild(
      miniBtn('🎯', 'Retarget: pick a different element on the live page', () => {
        startPick(a.url || undefined, (element) => {
          actions[i] = { ...actions[i], element };
          render();
        });
      })
    );
  }
  head.append(up, down, del);
  li.appendChild(head);

  if (a.action === 'input' || a.action === 'select') {
    li.appendChild(
      field('Value', textControl(a.value ?? '', (v) => { actions[i].value = v; }))
    );
  }
  if (a.action === 'mark_step') {
    li.appendChild(
      field('Label', textControl(a.label ?? '', (v) => { actions[i].label = v; }))
    );
  }
  if (a.action === 'upload') {
    const path = field(
      'File path (for setInputFiles) — leave blank to emit a TODO instead of a guess',
      textControl(a.filePath ?? '', (v) => { actions[i].filePath = v; })
    );
    li.appendChild(path);
  }
  // A cross-origin iframe has no reliable selector for the frame itself from
  // the inside — the generated locator will be a best-effort guess, so flag
  // it here rather than let it look as trustworthy as every other step.
  if (a.element?.frame?.crossOrigin) {
    const hint = document.createElement('p');
    hint.className = 'hint-warning';
    hint.textContent = '⚠ Recorded inside a cross-origin iframe — the generated locator will be unverified; double check it after generating.';
    li.appendChild(hint);
  }
  if (a.element) {
    li.appendChild(buildLocatorSection(i));
  }

  const ta = document.createElement('textarea');
  ta.className = 'desc-input';
  ta.rows = 2;
  ta.value = a.description ?? '';
  ta.placeholder =
    a.action === 'note'
      ? 'Describe the check to perform here — e.g. "assert the results table shows only rows whose Status is Active"'
      : 'What should this step do or verify? e.g. "each visible row\'s Name column contains the text typed in the search box"';
  ta.addEventListener('input', () => { actions[i].description = ta.value; });
  li.appendChild(field(a.action === 'note' ? 'Instruction' : 'Intent / what to verify (optional)', ta));

  const linkRow = document.createElement('div');
  linkRow.className = 'link-row';
  const addNote = document.createElement('button');
  addNote.type = 'button';
  addNote.className = 'link-add';
  addNote.textContent = '+ Add instruction step below';
  addNote.addEventListener('click', () => insertNoteAfter(i));
  const addAction = document.createElement('button');
  addAction.type = 'button';
  addAction.className = 'link-add';
  addAction.textContent = '+ Add action step below';
  addAction.addEventListener('click', () => {
    pendingInsert = { afterIndex: i, type: 'click', value: '' };
    render();
  });
  const addSearchAssert = document.createElement('button');
  addSearchAssert.type = 'button';
  addSearchAssert.className = 'link-add';
  addSearchAssert.textContent = '+ Assert search results';
  addSearchAssert.title = 'Insert a starting-point check for "did the search actually filter?" — edit the wording before generating';
  addSearchAssert.addEventListener('click', () => insertNoteAfter(i, SEARCH_RESULTS_TEMPLATE));
  linkRow.append(addNote, addAction, addSearchAssert);
  li.appendChild(linkRow);

  return li;
}

// The in-progress "add a real action step" form: pick a type (+ value for
// input/select), then pick the target element on the live page. Not part of
// `actions` until the pick resolves.
function buildPendingInsertRow(): HTMLLIElement {
  const pending = pendingInsert!;
  const li = document.createElement('li');
  li.className = 'step pending-insert';

  const typeSelect = document.createElement('select');
  (['click', 'input', 'select'] as const).forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === pending.type) opt.selected = true;
    typeSelect.appendChild(opt);
  });
  typeSelect.addEventListener('change', () => { pending.type = typeSelect.value as typeof pending.type; render(); });
  li.appendChild(field('New step type', typeSelect));

  if (pending.type !== 'click') {
    li.appendChild(field('Value', textControl(pending.value, (v) => { pending.value = v; })));
  }

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'secondary';
  pickBtn.textContent = 'Pick element on page';
  pickBtn.addEventListener('click', () => {
    const afterAction = actions[pending.afterIndex];
    startPick(afterAction?.url || undefined, (element, url) => {
      const newAction: RecordedAction = {
        action: pending.type,
        timestamp: Date.now(),
        url,
        element,
        ...(pending.type !== 'click' ? { value: pending.value } : {}),
      };
      actions.splice(pending.afterIndex + 1, 0, newAction);
      pendingInsert = null;
      render();
    });
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'link-add';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { pendingInsert = null; render(); });

  const row = document.createElement('div');
  row.className = 'step-head';
  row.append(pickBtn, cancelBtn);
  li.appendChild(row);

  return li;
}

function render() {
  listEl.innerHTML = '';
  actions.forEach((a, i) => {
    listEl.appendChild(buildRow(a, i));
    if (pendingInsert && pendingInsert.afterIndex === i) listEl.appendChild(buildPendingInsertRow());
  });
  emptyEl.hidden = actions.length > 0;
  countEl.textContent = `${actions.length} step${actions.length === 1 ? '' : 's'}`;
  generateBtn.disabled = actions.length === 0;
}

function cleanedActions(): RecordedAction[] {
  return actions
    .map((a) => {
      const d = a.description?.trim();
      if (d) return { ...a, description: d };
      const copy = { ...a };
      delete copy.description;
      return copy;
    })
    // A note with no text carries nothing — drop it rather than ship an empty step.
    .filter((a) => a.action !== 'note' || Boolean(a.description));
}

addNoteEndBtn.addEventListener('click', () => {
  actions.push(newNote());
  render();
  focusDesc(actions.length - 1);
});

closeButton.addEventListener('click', () => window.close());

generateBtn.addEventListener('click', async () => {
  clearAlert();
  testName = nameInput.value.trim() || testName || 'Untitled test';
  const payload = cleanedActions();
  if (payload.length === 0) {
    showAlert('Nothing to generate — every step was removed.');
    return;
  }

  generateBtn.disabled = true;
  const originalLabel = generateBtn.textContent;
  generateBtn.textContent = 'Generating…';

  // Persist the edited recording so reopening the tab shows the same edits.
  await chrome.storage.local.set({
    lastRecording: { isRecording: false, testName, actions: payload },
  });

  try {
    const res = await fetch(`${REVIEW_API_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testName, actions: payload, parentId }),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Error(detail.message || detail.error || `HTTP ${res.status}`);
    }
    const { id } = (await res.json()) as { id?: string };
    if (!id) throw new Error('Backend did not return a job id.');
    await chrome.storage.local.set({ lastRunId: id });
    location.href = `run.html?id=${id}`;
  } catch (err) {
    showAlert(
      `Could not generate: ${err instanceof Error ? err.message : String(err)}. Is the backend running at ${REVIEW_API_BASE}?`
    );
    generateBtn.disabled = false;
    generateBtn.textContent = originalLabel;
  }
});

(async () => {
  const fromRecording = new URLSearchParams(location.search).get('fromRecording');
  if (fromRecording) {
    // "Create a variant from this flow" (run.ts) — load a PAST recording by
    // id instead of the single most-recent one, so QA can branch off any
    // already-reviewed flow (e.g. to build a negative-path version) without
    // disturbing the original.
    try {
      const res = await fetch(`${REVIEW_API_BASE}/api/recordings/${fromRecording}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const recording = (await res.json()) as { testName?: string; actions?: RecordedAction[] };
      if (!recording.actions?.length) throw new Error('That recording has no actions.');
      parentId = fromRecording;
      testName = `${recording.testName || 'Untitled test'} (variant)`;
      nameInput.value = testName;
      actions = recording.actions;
      render();
    } catch (err) {
      showAlert(
        `Could not load recording ${fromRecording}: ${err instanceof Error ? err.message : String(err)}. Is the backend running at ${REVIEW_API_BASE}?`
      );
      generateBtn.disabled = true;
    }
    return;
  }

  const { lastRecording } = (await chrome.storage.local.get('lastRecording')) as {
    lastRecording?: RecorderState;
  };
  if (!lastRecording || !Array.isArray(lastRecording.actions) || lastRecording.actions.length === 0) {
    showAlert('No recording found. Record a flow from the extension popup first.');
    generateBtn.disabled = true;
    return;
  }
  testName = lastRecording.testName || 'Untitled test';
  nameInput.value = testName;
  actions = lastRecording.actions;
  render();
})();
