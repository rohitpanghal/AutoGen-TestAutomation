const RUN_PAGE = 'pages/run.html';
const REVIEW_PAGE = 'pages/review.html';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const statusDot = el<HTMLSpanElement>('status-dot');
const statusText = el<HTMLSpanElement>('status-text');
const setupPanel = el<HTMLDivElement>('setup');
const recordingPanel = el<HTMLDivElement>('recording');
const sentPanel = el<HTMLDivElement>('sent');
const errorPanel = el<HTMLDivElement>('error');
const testNameInput = el<HTMLInputElement>('test-name');
const actionCountEl = el<HTMLDivElement>('action-count');
const actionListEl = el<HTMLUListElement>('action-list');
const lastRunBtn = el<HTMLButtonElement>('last-run-btn');

function showPanel(panel: HTMLElement) {
  [setupPanel, recordingPanel, sentPanel, errorPanel].forEach((p) => p.classList.add('hidden'));
  panel.classList.remove('hidden');
}

function showError(message: string) {
  errorPanel.textContent = message;
  showPanel(errorPanel);
}

function openRunTab(id: string) {
  chrome.tabs.create({ url: `${chrome.runtime.getURL(RUN_PAGE)}?id=${id}` });
}

function openReviewTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL(REVIEW_PAGE) });
}

async function refreshLastRunButton() {
  const { lastRunId } = await chrome.storage.local.get('lastRunId');
  lastRunBtn.classList.toggle('hidden', !lastRunId);
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
    void refreshLastRunButton();
  }
}

function sendMessage<T = unknown>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message);
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
  if (state.actions.length === 0) {
    showError('No actions recorded.');
    return;
  }
  // STOP_RECORDING already persisted the recording to chrome.storage.local as
  // `lastRecording`; the review page picks it up from there.
  openReviewTab();
  showPanel(sentPanel);
});

lastRunBtn.addEventListener('click', async () => {
  const { lastRunId } = await chrome.storage.local.get('lastRunId');
  if (lastRunId) openRunTab(lastRunId);
});

el<HTMLButtonElement>('open-run-btn').addEventListener('click', async () => {
  const { lastRunId } = await chrome.storage.local.get('lastRunId');
  if (lastRunId) openRunTab(lastRunId);
});

el<HTMLButtonElement>('new-btn').addEventListener('click', async () => {
  const state = await sendMessage<RecorderState>({ type: 'CLEAR_RECORDING' });
  testNameInput.value = '';
  renderState(state);
});

(async () => {
  const state = await sendMessage<RecorderState>({ type: 'GET_STATE' });
  renderState(state);
})();
