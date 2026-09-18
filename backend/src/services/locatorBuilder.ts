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

// An xpath computed by content.ts is only emitted as `locator('xpath=...')`
// when it's text/attribute-anchored (xpathIsAnchored) — a positional xpath is
// exactly as fragile as the CSS nth-of-type fallback, so there'd be no point
// preferring it. The anchored form is for apps that give us nothing else to
// hook into: no testid, no stable class anywhere up the tree, no unambiguous
// role+name/text.
function xpathLeaf(el: ElementDescriptor): string | undefined {
  if (!el.xpathIsAnchored || !el.xpath) return undefined;
  return `locator(${quoted(`xpath=${el.xpath}`)})`;
}

// Returns the leaf expression plus whether it's still potentially non-unique on
// its own (needs a landmark/containerHint wrapper). Priority order is
// testId > role+name > label > text > anchored xpath > css, but a duplicated
// "unique" attribute (e.g. a shared component's hardcoded data-testid) is
// skipped in favor of whichever attribute the recorder actually found to be
// unique for this element — falling through beats trusting priority order blindly.
function buildLeaf(el: ElementDescriptor): { expr: string; needsScope: boolean } {
  // Form controls key off the `name` attribute before anything text-derived. A
  // <select>'s "text" is its whole concatenated option list, so getByRole(
  // 'combobox', { name }) balloons into a brittle multi-line literal and
  // getByText matches nothing — `select[name="produceType"]` is small, stable,
  // and survives option/label churn. Radio & checkbox groups share one name
  // across every option, so nameAmbiguous is set for them and we fall through.
  if (
    ['input', 'select', 'textarea'].includes(el.tag) &&
    !['radio', 'checkbox'].includes(el.type ?? '') &&
    el.name &&
    !el.nameAmbiguous
  ) {
    return { expr: `locator(${quoted(`${el.tag}[name="${el.name}"]`)})`, needsScope: false };
  }
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
    // A truncated capture can never equal the element's real, full text, so an
    // exact match against it is guaranteed to find nothing -- fall back to a
    // substring match instead.
    const exact = !el.textTruncated;
    return { expr: `getByText(${quoted(el.text)}, { exact: ${exact} })`, needsScope: Boolean(el.roleTextAmbiguous) || Boolean(el.textTruncated) };
  }
  // Nothing unique to key off — fall back to whatever we have, but it needs scoping.
  if (el.testId) {
    return { expr: `getByTestId(${quoted(el.testId)})`, needsScope: true };
  }
  const xpath = xpathLeaf(el);
  if (xpath) return { expr: xpath, needsScope: false };
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

// className (a component-specific CSS class captured on the container, e.g.
// ".warehouseCardText-ss") is preferred over role/tag when present: for
// div/span-based card grids, `locator(tag)` matches every nesting level of the
// card (outer wrapper, inner text block, ...), and hasText substring-matches
// all of them since text propagates up through ancestors — a class scoped to
// just the card component avoids that collision.
function buildContainerScope(hint: ContainerHint): string {
  const base = hint.className
    ? `locator(${quoted(`.${hint.className}`)})`
    : hint.role
      ? `getByRole(${quoted(hint.role)})`
      : `locator(${quoted(hint.tag)})`;
  return `${base}.filter({ hasText: ${quoted(hint.text)} })`;
}

// An element captured inside an iframe needs its locator scoped through a
// frameLocator(...) chain before anything else. Same-origin frames give us a
// real, verified-computable selector for each ancestor <iframe> (selectorChain,
// outermost first — see content.ts's getFrameChain); cross-origin frames give
// us nothing to hook into from inside, so there's no trustworthy "page.xxx"
// prefix to hand the LLM as a fact — buildLocatorExpression signals that by
// returning undefined rather than a guessed expression.
function framePrefix(el: ElementDescriptor): string | undefined {
  if (!el.frame) return 'page';
  if (el.frame.crossOrigin || el.frame.selectorChain.length === 0) return undefined;
  return `page${el.frame.selectorChain.map((sel) => `.frameLocator(${quoted(sel)})`).join('')}`;
}

// Returns a full "page.xxx" (or "page.frameLocator(...)....xxx") Playwright
// locator expression, or undefined when the element was captured inside a
// cross-origin iframe and no reliable frame selector can be computed — code
// shouldn't hand the LLM a fake "fact" to copy verbatim in that case. Only
// wraps the leaf in landmark/containerHint scoping when the CHOSEN leaf
// strategy is itself non-unique — e.g. if role+name already disambiguates
// (buildLeaf skipped a duplicated testId in favor of it), wrapping it further
// would just add noise.
export function buildLocatorExpression(el: ElementDescriptor): string | undefined {
  // QA's explicit choice (the review page's candidate list, or typed
  // directly) wins verbatim, before frame-prefixing, leaf-building, or the
  // hiddenDuplicate .filter — no exceptions. Same "human override wins
  // outright" contract description/filePath already have elsewhere in this
  // pipeline.
  if (el.locatorOverride?.trim()) return el.locatorOverride.trim();
  const prefix = framePrefix(el);
  if (!prefix) return undefined;
  const { expr, needsScope } = buildLeaf(el);
  let base = `${prefix}.${expr}`;
  if (needsScope) {
    // A landmark testId is a stable, purpose-built hook — always more specific
    // than a containerHint's class+hasText guess, so it wins when available.
    if (el.landmark?.testId) base = `${prefix}.${buildLandmarkScope(el.landmark)}.${expr}`;
    else if (el.containerHint) base = `${prefix}.${buildContainerScope(el.containerHint)}.${expr}`;
    else if (el.landmark) base = `${prefix}.${buildLandmarkScope(el.landmark)}.${expr}`;
    else {
      // No CSS class or landmark anywhere up the tree to scope through — the
      // gap an automation-unfriendly app forces us into. Anchored xpath can
      // still resolve it via the ancestor axis, which plain CSS has no way to
      // express without a class to hook into.
      const xpath = xpathLeaf(el);
      if (xpath) base = `${prefix}.${xpath}`;
    }
  }
  // hiddenDuplicate means a hasText/role/testid scope narrows *which* copy of
  // the component this is, but doesn't rule out that copy itself having a
  // sibling that's identical except for CSS visibility (a responsive
  // desktop/mobile pair, most commonly). Guarding on visibility is a no-op
  // when there's truly only one match, so it's safe to always apply here.
  return el.hiddenDuplicate ? `${base}.filter({ visible: true })` : base;
}

export function enrichActions(actions: RecordedAction[]): RecordedAction[] {
  return actions.map((action) => {
    if (!action.element) return action;
    const suggestedLocator = buildLocatorExpression(action.element);
    return {
      ...action,
      element: suggestedLocator ? { ...action.element, suggestedLocator } : action.element,
    };
  });
}
