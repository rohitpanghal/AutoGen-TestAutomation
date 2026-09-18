export interface LandmarkDescriptor {
  tag: string;
  role?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
}

export interface ContainerHint {
  tag: string;
  role?: string;
  text: string;
  className?: string;
}

// One viable way to point at an element, with its real match count on the
// page it was captured from. Computed once at record/pick time
// (extension/src/content.ts::buildLocatorCandidates) — purely for the review
// page's benefit, never sent to the LLM (anthropic.ts strips this before
// prompting: suggestedLocator already reflects whatever was chosen).
export interface LocatorCandidate {
  kind: 'testId' | 'name' | 'role' | 'text' | 'css' | 'xpath';
  expr: string;
  count: number;
  isDefault?: boolean;
}

export interface ElementDescriptor {
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
  ambiguous?: boolean;
  testIdAmbiguous?: boolean;
  roleTextAmbiguous?: boolean;
  // True when `tag[name="..."]` matches more than one element on the page (a
  // radio/checkbox group, or a form rendered twice). buildLeaf only keys a form
  // control off its `name` attribute when this is false.
  nameAmbiguous?: boolean;
  // At least one other DOM match exists for this element (by id/testId/role+text)
  // but every one of them is currently hidden -- e.g. a responsive desktop/mobile
  // nav pair. Playwright's strict mode still counts hidden matches, so the
  // generated locator needs a `.filter({ visible: true })` guard regardless of
  // whether containerHint scoping already narrowed the ambiguous case.
  hiddenDuplicate?: boolean;
  containerHint?: ContainerHint;
  suggestedLocator?: string;
  // Present whenever this element was captured inside an iframe. selectorChain
  // is empty and crossOrigin is true when the recorder couldn't reach
  // window.frameElement from inside the frame (cross-origin) — no reliable
  // selector for the frame itself exists in that case; frameUrl is a
  // best-effort hint for the LLM to build one manually. See locatorBuilder.ts
  // (frame-aware buildLocatorExpression) and SYSTEM_PROMPT in anthropic.ts.
  frame?: {
    selectorChain: string[];
    crossOrigin: boolean;
    frameUrl: string;
  };
  locatorCandidates?: LocatorCandidate[];
  // QA's explicit choice (from the review page's candidate list, or typed
  // directly) — wins verbatim over everything else when present. See
  // buildLocatorExpression in services/locatorBuilder.ts.
  locatorOverride?: string;
}

export interface RecordedAction {
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
  // Free-text intent the user attached to this step on the extension's review
  // page. The model treats it as authoritative — see SYSTEM_PROMPT below.
  description?: string;
  // 'upload' only: the real file path to pass to setInputFiles(...). A content
  // script cannot read this itself (browsers redact it from a file input's
  // .value), so it's supplied by the human on the review screen.
  filePath?: string;
}

export interface TestStep {
  description: string;
  expectedResult?: string;
}

export interface GeneratedTestCase {
  title: string;
  preconditions: string[];
  steps: TestStep[];
  expectedResults: string[];
}

export interface GenerateResult {
  id: string;
  testCase: GeneratedTestCase;
  playwrightCode: string;
}
