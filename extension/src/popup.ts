const BACKEND_URL = 'http://localhost:4000';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusDot = el<HTMLSpanElement>('status-dot');
const statusText = el<HTMLSpanElement>('status-text');
const setupPanel = el<HTMLDivElement>('setup');
const recordingPanel = el<HTMLDivElement>('recording');
const resultPanel = el<HTMLDivElement>('result');
const generatingPanel = el<HTMLDivElement>('generating');
const errorPanel = el<HTMLDivElement>('error');
const testNameInput = el<HTMLInputElement>('test-name');
const actionCountEl = el<HTMLDivElement>('action-count');
const actionListEl = el<HTMLUListElement>('action-list');
const testSummaryEl = el<HTMLDivElement>('test-summary');
const testCodeEl = el<HTMLPreElement>('test-code');
const healStatusEl = el<HTMLDivElement>('heal-status');

let lastGeneratedId: string | undefined;

interface HealHistoryEntry {
  attempt: number;
  passed: boolean;
  output: string;
  diagnosis?: string;
}

interface HealingInfo {
  status: 'passed' | 'failed' | 'running';
  attempts: number;
  suspectedRealBug: boolean;
  history: HealHistoryEntry[];
}

interface GenerateResponse {
  id: string;
  testCase: { title: string; steps?: unknown[] };
  playwrightCode: string;
  specFile: string;
  working: boolean;
  healing: HealingInfo;
}

function showPanel(panel: HTMLElement) {
  [setupPanel, recordingPanel, resultPanel, generatingPanel, errorPanel].forEach((p) => p.classList.add('hidden'));
  panel.classList.remove('hidden');
}

function showError(message: string) {
  errorPanel.textContent = message;
  showPanel(errorPanel);
}

function renderState(state: RecorderState) {
  if (state.isRecording) {
    statusDot.className = 'dot recording';
    statusText.textContent = `Recording: ${state.testName}`;
    actionCountEl.textContent = `${state.actions.length} action${state.actions.length === 1 ? '' : 's'} recorded`;
    actionListEl.innerHTML = '';
    state.actions.forEach((a) => {
      const li = document.createElement('li');
      if (a.action === 'mark_step') {
        li.className = 'step-marker';
        li.textContent = `— Step: ${a.label || 'unnamed'} —`;
      } else if (a.action === 'navigate') {
        li.textContent = `Navigate → ${a.url}`;
      } else {
        const desc = a.element?.text || a.element?.ariaLabel || a.element?.id || a.element?.tag || '';
        li.textContent = `${a.action}: ${desc}${a.value ? ` = "${a.value}"` : ''}`;
      }
      actionListEl.appendChild(li);
    });
    actionListEl.scrollTop = actionListEl.scrollHeight;
    showPanel(recordingPanel);
  } else {
    statusDot.className = 'dot idle';
    statusText.textContent = 'Idle';
    showPanel(setupPanel);
  }
}

function sendMessage<T = unknown>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

// Backend error responses carry { error, message } (see routes/*.ts) — surface
// that instead of just the status code, so failures are diagnosable from the
// popup alone without needing the backend's terminal output.
async function getErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.message || body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

el<HTMLButtonElement>('start-btn').addEventListener('click', async () => {
  const testName = testNameInput.value.trim() || 'Untitled test';
  const state = await sendMessage<RecorderState>({ type: 'START_RECORDING', testName });
  renderState(state);
});

el<HTMLButtonElement>('mark-step-btn').addEventListener('click', async () => {
  const label = window.prompt('Step label (optional):') || undefined;
  const state = await sendMessage<RecorderState>({ type: 'MARK_STEP', label });
  renderState(state);
});

el<HTMLButtonElement>('stop-btn').addEventListener('click', async () => {
  const state = await sendMessage<RecorderState>({ type: 'STOP_RECORDING' });
  renderState(state);
  await generateTest(state);
});

el<HTMLButtonElement>('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(testCodeEl.textContent || '');
});

el<HTMLButtonElement>('new-btn').addEventListener('click', async () => {
  const state = await sendMessage<RecorderState>({ type: 'CLEAR_RECORDING' });
  testNameInput.value = '';
  lastGeneratedId = undefined;
  healStatusEl.innerHTML = '';
  renderState(state);
});

async function generateTest(state: RecorderState) {
  if (state.actions.length === 0) {
    showError('No actions recorded.');
    return;
  }
  showPanel(generatingPanel);
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testName: state.testName, actions: state.actions }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`Could not reach backend at ${BACKEND_URL}. Is it running? (${message})`);
    return;
  }
  if (!res.ok) {
    showError(`Backend error (${res.status}): ${await getErrorDetail(res)}`);
    return;
  }
  const data = (await res.json()) as GenerateResponse;
  lastGeneratedId = typeof data.id === 'string' ? data.id : undefined;

  // Self-healing already ran server-side before this response came back —
  // if it never converged on passing code, don't show the user a broken
  // test case at all; explain why instead.
  if (!data.working) {
    const last = data.healing?.history?.[data.healing.history.length - 1];
    const reason = data.healing?.suspectedRealBug
      ? 'The recorded flow looks like it hit a real app issue rather than a broken test — review the app manually.'
      : `Self-healing could not produce a passing test after ${data.healing?.attempts ?? 0} attempt(s).`;
    showError(last?.diagnosis ? `${reason} (${last.diagnosis})` : reason);
    return;
  }

  const stepCount = data.testCase?.steps?.length ?? 0;
  testSummaryEl.textContent = data.testCase?.title ? `${data.testCase.title} — ${stepCount} steps` : 'Generated';
  testCodeEl.textContent = data.playwrightCode || '';
  healStatusEl.innerHTML = '';
  const attempts = data.healing?.attempts ?? 0;
  appendHealLine(
    attempts > 0 ? `✓ Verified — passed after ${attempts} self-heal attempt${attempts === 1 ? '' : 's'}.` : '✓ Verified — passed on first try.',
    'heal-pass'
  );
  showPanel(resultPanel);
}

function appendHealLine(text: string, className: string) {
  const div = document.createElement('div');
  div.className = `heal-attempt ${className}`;
  div.textContent = text;
  healStatusEl.appendChild(div);
}

(async () => {
  const state = await sendMessage<RecorderState>({ type: 'GET_STATE' });
  renderState(state);
})();
