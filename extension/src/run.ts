// Standalone results page. Opened in a tab by the popup right after it fires
// POST /api/generate, with ?id=<jobId>. It streams the job's progress over SSE
// and renders the generated test, the self-heal timeline, and (once done) a diff
// of what healing changed. Survives being closed and reopened — the backend
// replays buffered events on (re)connect.

const API_BASE = 'http://localhost:4000';

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const phaseBadge = $<HTMLSpanElement>('phase-badge');
const testTitleEl = $<HTMLDivElement>('test-title');
const alertEl = $<HTMLElement>('alert');
const summarySection = $<HTMLElement>('summary-section');
const summaryStepsEl = $<HTMLUListElement>('summary-steps');
const diffSection = $<HTMLElement>('diff-section');
const diffEl = $<HTMLPreElement>('diff');
const codeSection = $<HTMLElement>('code-section');
const codeEl = $<HTMLPreElement>('code');
const diagnosesSection = $<HTMLElement>('diagnoses-section');
const diagnosesEl = $<HTMLOListElement>('diagnoses');
const logEl = $<HTMLDivElement>('log');

const copyBtn = $<HTMLButtonElement>('copy-btn');
const rehealBtn = $<HTMLButtonElement>('reheal-btn');
const cancelBtn = $<HTMLButtonElement>('cancel-btn');
const closeBtn = $<HTMLButtonElement>('close-btn');

interface DonePayload {
  id: string;
  testCase?: { title?: string; steps?: { description: string; expectedResult?: string }[] };
  working: boolean;
  finalCode: string;
  healing: { status: string; attempts: number; suspectedRealBug: boolean };
}

let streamId = '';
let recordId = ''; // storage id for Re-heal — equals streamId for a generate job
let originalCode = '';
let finalCode = '';
let running = true;
let receivedAny = false;
let ended = false;
let source: EventSource | undefined;

function setBadge(text: string, cls = '') {
  phaseBadge.textContent = text;
  phaseBadge.className = `badge ${cls}`.trim();
}

function show(el: HTMLElement) {
  el.classList.remove('hidden');
}

function logLine(text: string, extra?: HTMLElement) {
  const line = document.createElement('div');
  line.className = 'line';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString() + '  ';
  line.appendChild(t);
  line.appendChild(document.createTextNode(text));
  if (extra) line.appendChild(extra);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function outputDetails(label: string, body: string): HTMLElement {
  const d = document.createElement('details');
  const s = document.createElement('summary');
  s.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = body;
  d.appendChild(s);
  d.appendChild(pre);
  return d;
}

function renderSummary(testCase: DonePayload['testCase']) {
  if (!testCase) return;
  testTitleEl.textContent = testCase.title ?? '';
  summaryStepsEl.innerHTML = '';
  (testCase.steps ?? []).forEach((step) => {
    const li = document.createElement('li');
    li.textContent = step.expectedResult
      ? `${step.description} → ${step.expectedResult}`
      : step.description;
    summaryStepsEl.appendChild(li);
  });
  if ((testCase.steps ?? []).length) show(summarySection);
}

function renderCode(code: string) {
  codeEl.textContent = code;
  show(codeSection);
}

// Minimal LCS line diff — no dependency (MV3 CSP blocks CDN scripts).
function renderDiff(a: string, b: string) {
  const oldLines = a.split('\n');
  const newLines = b.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  diffEl.innerHTML = '';
  const push = (cls: string, prefix: string, text: string) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = `${prefix}${text}`;
    diffEl.appendChild(span);
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      push('ctx', '  ', oldLines[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('del', '- ', oldLines[i]);
      i++;
    } else {
      push('add', '+ ', newLines[j]);
      j++;
    }
  }
  while (i < m) push('del', '- ', oldLines[i++]);
  while (j < n) push('add', '+ ', newLines[j++]);
  show(diffSection);
}

function addDiagnosis(attempt: number, text: string, realBug: boolean) {
  const li = document.createElement('li');
  li.textContent = `Attempt ${attempt}: ${text}`;
  if (realBug) {
    const tag = document.createElement('span');
    tag.className = 'real-bug';
    tag.textContent = '  [suspected real app bug]';
    li.appendChild(tag);
  }
  diagnosesEl.appendChild(li);
  show(diagnosesSection);
}

function finish(kind: 'passed' | 'failed' | 'error' | 'cancelled', message?: string) {
  running = false;
  cancelBtn.disabled = true;
  copyBtn.disabled = !(finalCode || originalCode);
  rehealBtn.disabled = !recordId;
  if (kind === 'passed') setBadge('Passed', 'passed');
  else if (kind === 'failed') setBadge('Needs review', 'failed');
  else if (kind === 'cancelled') setBadge('Cancelled', 'cancelled');
  else setBadge('Error', 'error');
  if (message) {
    alertEl.textContent = message;
    alertEl.className = kind === 'failed' ? 'alert warn' : 'alert';
    show(alertEl);
  }
}

function handlePhase(data: { phase: string; message?: string; queuePosition?: number }) {
  const msg = data.message || data.phase;
  if (data.phase === 'queued') {
    setBadge(data.queuePosition ? `Queued (#${data.queuePosition})` : 'Queued');
    logLine(`Queued — ${msg}`);
  } else if (data.phase === 'generating') {
    setBadge('Generating…', 'running');
    logLine(msg);
  } else if (data.phase === 'healing') {
    setBadge('Verifying…', 'running');
    logLine(msg);
  } else if (data.phase === 'done') {
    logLine(msg);
  } else if (data.phase === 'error') {
    logLine(msg);
  }
}

function attach(id: string) {
  streamId = id;
  source?.close();
  source = new EventSource(`${API_BASE}/api/jobs/${id}/events`);

  source.addEventListener('phase', (e) => {
    receivedAny = true;
    handlePhase(JSON.parse((e as MessageEvent).data));
  });

  source.addEventListener('generated', (e) => {
    receivedAny = true;
    const d = JSON.parse((e as MessageEvent).data) as {
      testCase: DonePayload['testCase'];
      playwrightCode: string;
    };
    originalCode = d.playwrightCode;
    finalCode = d.playwrightCode;
    renderSummary(d.testCase);
    renderCode(d.playwrightCode);
    copyBtn.disabled = false;
    logLine('Generated test case + Playwright code.');
  });

  source.addEventListener('heal:attempt-start', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { attempt: number; maxAttempts: number };
    setBadge(`Healing ${d.attempt}/${d.maxAttempts}…`, 'running');
    logLine(`Heal attempt ${d.attempt}/${d.maxAttempts}: running the spec…`);
  });

  source.addEventListener('heal:run-result', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as {
      attempt: number;
      passed: boolean;
      outputTail: string;
    };
    logLine(
      `Attempt ${d.attempt}: ${d.passed ? 'PASSED' : 'failed'}.`,
      d.outputTail ? outputDetails('Playwright output', d.outputTail) : undefined
    );
  });

  source.addEventListener('heal:diagnosis', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as {
      attempt: number;
      diagnosis: string;
      likelyRealBug: boolean;
    };
    addDiagnosis(d.attempt, d.diagnosis, d.likelyRealBug);
    logLine(`Attempt ${d.attempt} diagnosis: ${d.diagnosis}`);
  });

  source.addEventListener('heal:browser', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { message: string };
    logLine(d.message);
  });

  source.addEventListener('done', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as DonePayload;
    receivedAny = true;
    recordId = d.id || recordId;
    finalCode = d.finalCode || finalCode;
    renderSummary(d.testCase);
    renderCode(finalCode);
    if (originalCode && finalCode && originalCode !== finalCode) {
      renderDiff(originalCode, finalCode);
      logLine(`Self-healing edited the test over ${d.healing.attempts} attempt(s).`);
    }
    if (d.healing.suspectedRealBug) {
      finish(
        'failed',
        'The self-heal loop thinks the recorded flow hit a real application issue, not a broken test. Review the app.'
      );
    } else if (d.working) {
      finish('passed');
    } else {
      finish('failed', `Self-healing could not get the test passing after ${d.healing.attempts} attempt(s).`);
    }
  });

  source.addEventListener('error', (e) => {
    // Two very different "error" events land here: an SSE transport error
    // (no .data) and our own job-error event (JSON payload). And after a normal
    // stream close the browser fires a transport error too — ignore it once the
    // job has ended.
    if (ended) return;
    const raw = (e as MessageEvent).data;
    if (raw) {
      receivedAny = true;
      const d = JSON.parse(raw) as { message: string };
      logLine(`Error: ${d.message}`);
      ended = true;
      source?.close();
      finish('error', d.message);
    } else if (!receivedAny) {
      setBadge('Disconnected', 'error');
      alertEl.textContent =
        `Could not reach the job stream at ${API_BASE}. Is the backend running? The job id may also have expired.`;
      show(alertEl);
    }
  });

  source.addEventListener('end', () => {
    ended = true;
    source?.close();
    if (running) {
      // Terminal state without a done/error payload (e.g. cancelled while queued).
      finish('cancelled');
    }
  });
}

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(finalCode || originalCode || '');
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy code'), 1200);
});

cancelBtn.addEventListener('click', async () => {
  cancelBtn.disabled = true;
  logLine('Cancellation requested…');
  try {
    await fetch(`${API_BASE}/api/jobs/${streamId}`, { method: 'DELETE' });
  } catch {
    /* the stream's end event still drives the UI */
  }
});

rehealBtn.addEventListener('click', async () => {
  if (!recordId) return;
  rehealBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/heal/${recordId}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    location.search = `?id=${id}`; // reload fresh against the new job
  } catch (err) {
    rehealBtn.disabled = false;
    alertEl.textContent = `Could not start re-heal: ${err instanceof Error ? err.message : String(err)}`;
    show(alertEl);
  }
});

closeBtn.addEventListener('click', () => window.close());

(async () => {
  let id = new URLSearchParams(location.search).get('id') ?? '';
  if (!id) {
    const stored = await chrome.storage.local.get('lastRunId');
    id = (stored.lastRunId as string) ?? '';
  }
  if (!id) {
    setBadge('No run', 'error');
    alertEl.textContent = 'No job id in the URL and no recent run stored.';
    show(alertEl);
    return;
  }
  recordId = id;
  cancelBtn.disabled = false;
  attach(id);
})();
