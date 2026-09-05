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
  // At least one other DOM match exists for this element (by id/testId/role+text)
  // but every one of them is currently hidden -- e.g. a responsive desktop/mobile
  // nav pair. Playwright's strict mode still counts hidden matches, so the
  // generated locator needs a `.filter({ visible: true })` guard regardless of
  // whether containerHint scoping already narrowed the ambiguous case.
  hiddenDuplicate?: boolean;
  containerHint?: ContainerHint;
  suggestedLocator?: string;
}

export interface RecordedAction {
  action: 'click' | 'input' | 'select' | 'navigate' | 'mark_step';
  timestamp: number;
  url: string;
  element?: ElementDescriptor;
  value?: string;
  masked?: boolean;
  label?: string;
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
