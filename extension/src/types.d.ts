interface LandmarkDescriptor {
  tag: string;
  role?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
}

// One viable way to point at an element, with its real match count on the
// page it was captured from (self-inclusive, same semantics
// countXPathMatches already has). Computed once at record/pick time
// (content.ts::buildLocatorCandidates) -- purely for the review page's
// benefit, never sent to the LLM (see anthropic.ts, which strips this before
// prompting: suggestedLocator already reflects whatever was chosen).
interface LocatorCandidate {
  kind: 'testId' | 'name' | 'role' | 'text' | 'css' | 'xpath';
  expr: string;
  count: number;
  // The one buildLocatorCandidates predicts buildLeaf would auto-pick
  // server-side (first candidate with count === 1, else the first at all).
  isDefault?: boolean;
}

interface ContainerHint {
  tag: string;
  role?: string;
  text: string;
  // A non-utility CSS class found on the container, when one exists — a much
  // tighter scoping selector than the bare tag name for div/span-based grids.
  className?: string;
}

interface ElementDescriptor {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  // True when `text` was cut off at the recorder's capture limit rather than
  // being the element's full trimmed innerText -- codegen must never build an
  // exact-match locator off a truncated string, since it can then never equal
  // the real DOM text.
  textTruncated?: boolean;
  css: string;
  xpath: string;
  nearbyText?: string;
  // True if `xpath` is a text/attribute-anchored expression (survives DOM
  // reordering) rather than the purely positional sibling-index path -- codegen
  // only wants to use xpath as a fallback when it's actually more robust than
  // the CSS fallback, not just a different flavor of the same fragility.
  xpathIsAnchored?: boolean;
  testId?: string;
  landmark?: LandmarkDescriptor;
  // True if ANY of the signals below indicate a collision — used to decide
  // whether it's worth computing containerHint at all.
  ambiguous?: boolean;
  // Per-attribute collision flags. Real markup can duplicate "unique" hooks
  // independently of each other (e.g. two buttons sharing one data-testid but
  // having different visible text) — tracking them separately lets codegen
  // fall through to whichever attribute is actually unique for this element,
  // instead of assuming the highest-priority one (data-testid) is always safe.
  testIdAmbiguous?: boolean;
  roleTextAmbiguous?: boolean;
  // True when `tag[name="..."]` matches more than one element on the page (a
  // radio/checkbox group, or a form rendered twice). buildLeaf only prefers the
  // `name` attribute for a form control when this is false.
  nameAmbiguous?: boolean;
  // At least one other DOM match exists for this element (by id/testId/role+text)
  // but every one of them is currently hidden -- e.g. a responsive desktop/mobile
  // nav pair. Playwright's strict mode still counts hidden matches, so codegen
  // needs to guard the emitted locator with `.filter({ visible: true })`
  // regardless of whether containerHint scoping already narrowed the ambiguous case.
  hiddenDuplicate?: boolean;
  containerHint?: ContainerHint;
  // Computed server-side (backend/src/services/locatorBuilder.ts), not by this recorder.
  suggestedLocator?: string;
  // Present whenever this element was captured inside an iframe (window !==
  // window.top). selectorChain is empty and crossOrigin is true when the
  // recorder couldn't reach window.frameElement from inside — no reliable
  // selector for the frame itself exists in that case; frameUrl is a
  // best-effort hint for the LLM to build one manually.
  frame?: {
    selectorChain: string[];
    crossOrigin: boolean;
    frameUrl: string;
  };
  locatorCandidates?: LocatorCandidate[];
  // QA's explicit choice (from the review page's candidate list, or typed
  // directly) -- wins verbatim over everything else when present. See
  // buildLocatorExpression in backend/src/services/locatorBuilder.ts.
  locatorOverride?: string;
}

interface RecordedAction {
  // 'note' is a review-time insertion: a description-only step with no recorded
  // DOM event, used to spell out an assertion/comparison the model should
  // implement at that point in the flow.
  // 'upload' is a change event on an <input type="file">. 'keydown' is a
  // semantically meaningful key press (Enter / Escape / Tab) captured
  // separately from 'input'/'select' since it has no element value to commit.
  action: 'click' | 'input' | 'select' | 'navigate' | 'mark_step' | 'note' | 'upload' | 'keydown';
  timestamp: number;
  url: string;
  element?: ElementDescriptor;
  // For 'input'/'select': the field value. For 'upload': the recorded
  // filename (display-only, never usable as a real path). For 'keydown': the
  // key combo in Playwright .press() format, e.g. "Enter", "Shift+Tab".
  value?: string;
  masked?: boolean;
  label?: string;
  // Free-text intent the user attached to this step on the review page. The
  // model treats it as authoritative — see SYSTEM_PROMPT in backend/anthropic.ts.
  description?: string;
  // 'upload' only: the real file path to pass to setInputFiles(...). A content
  // script cannot read this itself (browsers redact it from a file input's
  // .value), so it's supplied by the human on the review screen.
  filePath?: string;
}

type ExtensionMessage =
  | { type: 'RECORD_ACTION'; action: RecordedAction }
  | { type: 'START_RECORDING'; testName: string }
  | { type: 'STOP_RECORDING' }
  | { type: 'MARK_STEP'; label?: string }
  | { type: 'GET_STATE' }
  | { type: 'CLEAR_RECORDING' }
  // Element picker (review.ts retarget / insert-step flows). review.ts ->
  // background: start a pick, optionally navigating to `url` first.
  // background -> the target tab's content script: actually enter pick mode.
  // content script -> background: the result, relayed to review.ts via
  // chrome.storage.local's `pendingPick` key (see background.ts).
  | { type: 'START_PICK'; requestId: string; url?: string }
  | { type: 'ENTER_PICK_MODE'; requestId: string }
  | { type: 'ELEMENT_PICKED'; requestId: string; element: ElementDescriptor; url: string }
  // QA backed out (in-page banner's Cancel, or review.ts's own cancel
  // control) — tells background to stop re-arming this tab after future
  // navigations (see activePick in background.ts).
  | { type: 'CANCEL_PICK'; requestId: string };

interface RecorderState {
  isRecording: boolean;
  testName: string;
  actions: RecordedAction[];
  // The tab the recording was started from. Actions/navigations from any
  // other tab (a stray click while checking email, a target=_blank link
  // opening a new tab) are dropped rather than bleeding into the recording.
  recordingTabId?: number;
}
