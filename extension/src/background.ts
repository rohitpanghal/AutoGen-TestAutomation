// Single source of truth for recording state. Content scripts always report events;
// this worker decides whether to keep them (isRecording) and owns navigation capture.

let state: RecorderState = { isRecording: false, testName: '', actions: [] };

// The live element-picker session, if any. Content scripts reset on every
// navigation, so this is what makes "browse first, then pick" possible --
// the webNavigation listeners below re-send ENTER_PICK_MODE to this tab after
// every navigation for as long as this stays set. Cleared once the pick
// resolves (ELEMENT_PICKED), is explicitly cancelled (CANCEL_PICK), or the
// tab closes.
let activePick: { tabId: number; requestId: string } | null = null;

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING':
      // Recorded from the popup, not a content script, so `sender.tab` isn't
      // available here -- ask for the active tab explicitly. Everything from
      // any other tab gets dropped for the rest of this recording (see
      // RECORD_ACTION / recordNavigation below).
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        state = { isRecording: true, testName: message.testName, actions: [], recordingTabId: tabs[0]?.id };
        sendResponse(state);
      });
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
      // content.ts is injected into every tab; only keep actions from the
      // tab the recording was actually started on.
      if (state.isRecording && sender.tab?.id === state.recordingTabId) {
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

    case 'START_PICK': {
      const { requestId, url } = message;
      const reuseTabId = state.recordingTabId;
      const openFresh = () => {
        if (!url) return;
        chrome.tabs.create({ url }, (newTab) => {
          if (newTab.id === undefined) return;
          activePick = { tabId: newTab.id, requestId };
          sendEnterPickWhenReady(newTab.id, requestId);
        });
      };
      if (reuseTabId !== undefined) {
        chrome.tabs.get(reuseTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            openFresh();
            return;
          }
          activePick = { tabId: reuseTabId, requestId };
          sendEnterPickWhenReady(reuseTabId, requestId);
          chrome.tabs.update(reuseTabId, { active: true });
          if (tab.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true });
        });
      } else {
        openFresh();
      }
      sendResponse({ ok: true });
      break;
    }

    // Relayed to review.ts (an extension page, not a content script, so it
    // can't receive chrome.tabs.sendMessage directly) via storage.onChanged —
    // the same pattern already used for lastRecording.
    case 'ELEMENT_PICKED':
      if (activePick?.requestId === message.requestId) activePick = null;
      chrome.storage.local.set({
        pendingPick: { requestId: message.requestId, element: message.element, url: message.url },
      });
      sendResponse({ ok: true });
      break;

    case 'CANCEL_PICK':
      if (activePick?.requestId === message.requestId) activePick = null;
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// A closed tab can't be re-armed — drop the session rather than let a later
// navigation event (there won't be one, but belt-and-suspenders) try to
// message a tab that no longer exists.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activePick?.tabId === tabId) activePick = null;
});

// Waits for the target tab to finish loading (a freshly created tab, or one
// mid-navigation) before delivering ENTER_PICK_MODE, so the message isn't
// lost to a content script that hasn't been injected yet.
function sendEnterPickWhenReady(tabId: number, requestId: string) {
  const trySend = () => chrome.tabs.sendMessage(tabId, { type: 'ENTER_PICK_MODE', requestId }).catch(() => {});
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab.status === 'complete') {
      trySend();
      return;
    }
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        trySend();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// A `navigate` action must be recorded for BOTH a full document load
// (onCommitted) and an SPA route change (onHistoryStateUpdated for History API
// pushState/replaceState, onReferenceFragmentUpdated for hash routers). The
// generator keys `waitForURL` placement off a click being immediately followed
// by a navigate action; an app that transitions via pushState (login -> app,
// Proceed -> next page) fires only the History events, so without these the
// generator has to guess which click navigated and pins the wait to the wrong
// one.
function recordNavigation(tabId: number, frameId: number, url: string): void {
  if (frameId !== 0 || !state.isRecording || tabId !== state.recordingTabId) return;
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

// Re-arm an in-progress pick session on the same top-frame navigation events
// recordNavigation already watches (a full load AND an SPA route change both
// need this) -- a fresh page load wipes content.ts's module state, so
// without this "browse to a different page, then pick" couldn't work.
function maybeReArmPick(tabId: number, frameId: number): void {
  if (frameId !== 0 || !activePick || activePick.tabId !== tabId) return;
  sendEnterPickWhenReady(activePick.tabId, activePick.requestId);
}

function onNavigation(d: { tabId: number; frameId: number; url: string }): void {
  recordNavigation(d.tabId, d.frameId, d.url);
  maybeReArmPick(d.tabId, d.frameId);
}

chrome.webNavigation.onCommitted.addListener(onNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(onNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onNavigation);
