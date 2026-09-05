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

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !state.isRecording) return;
  state.actions.push({ action: 'navigate', timestamp: Date.now(), url: details.url });
});
