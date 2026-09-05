// Single source of truth for recording state. Content scripts always report events;
// this worker decides whether to keep them (isRecording) and owns navigation capture.

let state: RecorderState = { isRecording: false, testName: '', actions: [] };

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING':
      state = { isRecording: true, testName: message.testName, actions: [] };
      sendResponse(state);
      break;

    case 'STOP_RECORDING':
      state = { ...state, isRecording: false };
      chrome.storage.local.set({ lastRecording: state });
      sendResponse(state);
      break;

    case 'MARK_STEP':
      if (state.isRecording) {
        state.actions.push({ action: 'mark_step', timestamp: Date.now(), url: '', label: message.label });
      }
      sendResponse(state);
      break;

    case 'RECORD_ACTION':
      if (state.isRecording) {
        state.actions.push(message.action);
      }
      sendResponse({ ok: true });
      break;

    case 'GET_STATE':
      sendResponse(state);
      break;

    case 'CLEAR_RECORDING':
      state = { isRecording: false, testName: '', actions: [] };
      chrome.storage.local.remove('lastRecording');
      sendResponse(state);
      break;
  }
  return true;
});

// A `navigate` action must be recorded for BOTH a full document load
// (onCommitted) and an SPA route change (onHistoryStateUpdated for History API
// pushState/replaceState, onReferenceFragmentUpdated for hash routers). The
// generator keys `waitForURL` placement off a click being immediately followed
// by a navigate action; an app that transitions via pushState (login -> app,
// Proceed -> next page) fires only the History events, so without these the
// generator has to guess which click navigated and pins the wait to the wrong
// one.
function recordNavigation(frameId: number, url: string): void {
  if (frameId !== 0 || !state.isRecording) return;
  // Ignore no-op repeats: pushState to an unchanged URL, or the
  // onCommitted + onHistoryStateUpdated pair a single load can emit.
  for (let i = state.actions.length - 1; i >= 0; i--) {
    if (state.actions[i].action === 'navigate') {
      if (state.actions[i].url === url) return;
      break;
    }
  }
  state.actions.push({ action: 'navigate', timestamp: Date.now(), url });
}

chrome.webNavigation.onCommitted.addListener((d) => recordNavigation(d.frameId, d.url));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => recordNavigation(d.frameId, d.url));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => recordNavigation(d.frameId, d.url));
