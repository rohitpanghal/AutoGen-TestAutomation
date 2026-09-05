// Deterministic locator generation. This exists because relying on prose rules
// in the LLM prompt to "please scope ambiguous selectors correctly" was not
// reliable in practice — the model kept falling back to a bare #id even when
// told not to. Computing the correct, already-scoped Playwright expression in
// code and handing it to the model as a fact to use (not a rule to reason
// about) is the deterministic-pipeline principle: don't make the AI responsible
// for something a few lines of code can get right every time.
import type { ContainerHint, ElementDescriptor, LandmarkDescriptor, RecordedAction } from '../types.js';

function sanitizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function quoted(s: string): string {
  return `'${escapeStr(sanitizeText(s))}'`;
}

// Returns the leaf expression plus whether it's still potentially non-unique on
// its own (needs a landmark/containerHint wrapper). Priority order is
// testId > role+name > label > text > css, but a duplicated "unique" attribute
// (e.g. a shared component's hardcoded data-testid) is skipped in favor of
// whichever attribute the recorder actually found to be unique for this element
// — falling through beats trusting priority order blindly.
function buildLeaf(el: ElementDescriptor): { expr: string; needsScope: boolean } {
  if (el.testId && !el.testIdAmbiguous) {
    return { expr: `getByTestId(${quoted(el.testId)})`, needsScope: false };
  }
  if (el.role && (el.text || el.ariaLabel) && !el.roleTextAmbiguous) {
    const name = el.ariaLabel || el.text!;
    return { expr: `getByRole(${quoted(el.role)}, { name: ${quoted(name)} })`, needsScope: false };
  }
  if (['input', 'select', 'textarea'].includes(el.tag) && el.nearbyText) {
    return { expr: `getByLabel(${quoted(el.nearbyText)})`, needsScope: false };
  }
  if (el.text) {
    return { expr: `getByText(${quoted(el.text)}, { exact: true })`, needsScope: Boolean(el.roleTextAmbiguous) };
  }
  // Nothing unique to key off — fall back to whatever we have, but it needs scoping.
  if (el.testId) {
    return { expr: `getByTestId(${quoted(el.testId)})`, needsScope: true };
  }
  return { expr: `locator(${quoted(el.css)})`, needsScope: true };
}

function buildLandmarkScope(landmark: LandmarkDescriptor): string {
  if (landmark.testId) return `getByTestId(${quoted(landmark.testId)})`;
  if (landmark.role) {
    return landmark.ariaLabel
      ? `getByRole(${quoted(landmark.role)}, { name: ${quoted(landmark.ariaLabel)} })`
      : `getByRole(${quoted(landmark.role)})`;
  }
  return `locator(${quoted(landmark.tag)})`;
}

function buildContainerScope(hint: ContainerHint): string {
  const base = hint.role ? `getByRole(${quoted(hint.role)})` : `locator(${quoted(hint.tag)})`;
  return `${base}.filter({ hasText: ${quoted(hint.text)} })`;
}

// Returns a full "page.xxx" Playwright locator expression. Only wraps the leaf
// in landmark/containerHint scoping when the CHOSEN leaf strategy is itself
// non-unique — e.g. if role+name already disambiguates (buildLeaf skipped a
// duplicated testId in favor of it), wrapping it further would just add noise.
export function buildLocatorExpression(el: ElementDescriptor): string {
  const { expr, needsScope } = buildLeaf(el);
  if (needsScope) {
    if (el.containerHint) return `page.${buildContainerScope(el.containerHint)}.${expr}`;
    if (el.landmark) return `page.${buildLandmarkScope(el.landmark)}.${expr}`;
  }
  return `page.${expr}`;
}

export function enrichActions(actions: RecordedAction[]): RecordedAction[] {
  return actions.map((action) => {
    if (!action.element) return action;
    return { ...action, element: { ...action.element, suggestedLocator: buildLocatorExpression(action.element) } };
  });
}
