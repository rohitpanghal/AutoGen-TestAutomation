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

function showAlert(msg: string) {
  alertBox.textContent = msg;
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

function newNote(): RecordedAction {
  return { action: 'note', timestamp: Date.now(), url: '', description: '' };
}

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

function insertNoteAfter(i: number) {
  actions.splice(i + 1, 0, newNote());
  render();
  focusDesc(i + 1);
}

function focusDesc(i: number) {
  listEl.querySelectorAll<HTMLTextAreaElement>('.desc-input')[i]?.focus();
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

  head.append(badge, summary, spacer, up, down, del);
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

  const addNote = document.createElement('button');
  addNote.type = 'button';
  addNote.className = 'link-add';
  addNote.textContent = '+ Add instruction step below';
  addNote.addEventListener('click', () => insertNoteAfter(i));
  li.appendChild(addNote);

  return li;
}

function render() {
  listEl.innerHTML = '';
  actions.forEach((a, i) => listEl.appendChild(buildRow(a, i)));
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
      body: JSON.stringify({ testName, actions: payload }),
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
