interface LandmarkDescriptor {
  tag: string;
  role?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
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
  // At least one other DOM match exists for this element (by id/testId/role+text)
  // but every one of them is currently hidden -- e.g. a responsive desktop/mobile
  // nav pair. Playwright's strict mode still counts hidden matches, so codegen
  // needs to guard the emitted locator with `.filter({ visible: true })`
  // regardless of whether containerHint scoping already narrowed the ambiguous case.
  hiddenDuplicate?: boolean;
  containerHint?: ContainerHint;
  // Computed server-side (backend/src/services/locatorBuilder.ts), not by this recorder.
  suggestedLocator?: string;
}

interface RecordedAction {
  action: 'click' | 'input' | 'select' | 'navigate' | 'mark_step';
  timestamp: number;
  url: string;
  element?: ElementDescriptor;
  value?: string;
  masked?: boolean;
  label?: string;
}

type ExtensionMessage =
  | { type: 'RECORD_ACTION'; action: RecordedAction }
  | { type: 'START_RECORDING'; testName: string }
  | { type: 'STOP_RECORDING' }
  | { type: 'MARK_STEP'; label?: string }
  | { type: 'GET_STATE' }
  | { type: 'CLEAR_RECORDING' };

interface RecorderState {
  isRecording: boolean;
  testName: string;
  actions: RecordedAction[];
}
