// Deterministic recorder: captures DOM context for each action, never coordinates.
// Recording on/off state lives in the background service worker; this script always
// reports events and lets the background decide whether to keep them.

function getCssSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let selector = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(selector);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function getXPath(el: Element): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
    node = node.parentElement;
  }
  return '/' + parts.join('/');
}

// A purely positional xpath (built above from sibling index at every level)
// is exactly as fragile as the CSS nth-of-type fallback -- it breaks the
// moment a sibling is inserted or removed anywhere in the chain. XPath's real
// advantage over CSS is axis navigation: it can select an ancestor purely by
// a descendant's text/attribute, without needing any class to hook into --
// something plenty of real apps (utility-class-only styling, hashed/obfuscated
// class names, no data-testid convention) never give us. This is only used as
// a last resort, when nothing else (testid, role+name, label, unique text,
// containerHint) already produced something better.
function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(",\"'\",")})`;
}

function countXPathMatches(expr: string): number {
  try {
    return document.evaluate(`count(${expr})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue;
  } catch {
    return 0;
  }
}

// Same shrink-to-shortest-unique-prefix idea as shrinkToUniqueText, expressed
// as an xpath contains() check instead of a CSS hasText check.
function shrinkXPathText(tag: string, fullText: string): string {
  const words = fullText.split(' ');
  for (let n = 1; n < words.length; n++) {
    const candidate = words.slice(0, n).join(' ');
    if (countXPathMatches(`//${tag}[contains(normalize-space(.), ${xpathLiteral(candidate)})]`) === 1) {
      return candidate;
    }
  }
  return fullText;
}

// Text-anchored xpath for `el` itself, or (when el has no text of its own --
// an icon-only button, say) for the nearest ancestor with page-unique text,
// addressing `el` relative to that ancestor. Returns undefined if no text
// anywhere in the chain is page-unique, in which case the caller should fall
// back to the plain structural xpath/css instead.
function getTextAnchoredXPath(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  const ownText = normalizeText((el as HTMLElement).innerText || '').slice(0, 100);
  if (ownText && countXPathMatches(`//${tag}[contains(normalize-space(.), ${xpathLiteral(ownText)})]`) === 1) {
    const shortText = shrinkXPathText(tag, ownText);
    return `//${tag}[contains(normalize-space(.), ${xpathLiteral(shortText)})]`;
  }
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < 10) {
    const text = normalizeText((node as HTMLElement).innerText || '').slice(0, 100);
    if (text) {
      const ancestorTag = node.tagName.toLowerCase();
      if (countXPathMatches(`//${ancestorTag}[contains(normalize-space(.), ${xpathLiteral(text)})]`) === 1) {
        const shortText = shrinkXPathText(ancestorTag, text);
        const scoped = `//${ancestorTag}[contains(normalize-space(.), ${xpathLiteral(shortText)})]`;
        const relative = ownText
          ? `${scoped}//${tag}[contains(normalize-space(.), ${xpathLiteral(ownText)})]`
          : `${scoped}//${tag}`;
        if (countXPathMatches(relative) === 1) return relative;
      }
    }
    node = node.parentElement;
    depth++;
  }
  return undefined;
}

function getNearbyText(el: Element): string | undefined {
  const label =
    el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
  if (label?.textContent) return label.textContent.trim().slice(0, 100);
  const prev = el.previousElementSibling;
  if (prev?.textContent) return prev.textContent.trim().slice(0, 100);
  return undefined;
}

const LANDMARK_ROLES = ['dialog', 'main', 'navigation', 'form', 'banner', 'contentinfo', 'region'];
const LANDMARK_TAGS = ['nav', 'header', 'footer', 'form', 'dialog', 'main'];

// Mirrors buildLeaf's priority order (backend/src/services/locatorBuilder.ts)
// so getLandmark can verify a candidate ancestor against the SAME leaf the
// server will actually build -- content.ts has DOM access but not buildLeaf's
// logic, and buildLeaf has the logic but no DOM, so this is the one place a
// small amount of duplication is unavoidable. Keep in sync with buildLeaf.
type LeafPrediction =
  | { needsScope: false }
  | { needsScope: true; kind: 'text'; text: string; exact: boolean }
  | { needsScope: true; kind: 'testId'; testId: string }
  | { needsScope: true; kind: 'other' }; // raw css fallback -- nothing cheap to verify

function resolveLeafPrediction(ctx: {
  testId?: string;
  testIdAmbiguous: boolean;
  role?: string;
  text?: string;
  ariaLabel?: string;
  roleTextAmbiguous: boolean;
  tag: string;
  nearbyText?: string;
  textTruncated: boolean;
  xpathIsAnchored: boolean;
}): LeafPrediction {
  if (ctx.testId && !ctx.testIdAmbiguous) return { needsScope: false };
  if (ctx.role && (ctx.text || ctx.ariaLabel) && !ctx.roleTextAmbiguous) return { needsScope: false };
  if (['input', 'select', 'textarea'].includes(ctx.tag) && ctx.nearbyText) return { needsScope: false };
  if (ctx.text) {
    const needsScope = ctx.roleTextAmbiguous || ctx.textTruncated;
    if (!needsScope) return { needsScope: false };
    return { needsScope: true, kind: 'text', text: ctx.text, exact: !ctx.textTruncated };
  }
  if (ctx.testId) return { needsScope: true, kind: 'testId', testId: ctx.testId };
  if (ctx.xpathIsAnchored) return { needsScope: false };
  return { needsScope: true, kind: 'other' };
}

// Counts, within `node`'s subtree, how many elements would match the leaf
// buildLeaf is predicted to emit. Deliberately does NOT seed the match list
// with `el` the way hasSameRoleAndText does -- node is an ancestor of el, so
// node.querySelectorAll('*') already includes el itself, and count === 1
// naturally means "only el matches within this scope."
//
// buildLeaf's actual getByText(...) call runs its text through sanitizeText
// (whitespace-collapsed) before it ever reaches Playwright, so comparing with
// that same normalization here -- via getComparableText, which also survives
// a hidden desktop/mobile duplicate that innerText alone would blank out --
// is what makes this check predict what Playwright will actually match.
function landmarkVerifies(node: Element, leaf: Extract<LeafPrediction, { needsScope: true }>): boolean {
  if (leaf.kind === 'other') return false;
  const targetText = leaf.kind === 'text' ? normalizeText(leaf.text).slice(0, 80) : undefined;
  let count = 0;
  node.querySelectorAll('*').forEach((candidate) => {
    if (leaf.kind === 'text') {
      const t = getComparableText(candidate);
      if (t == null || targetText == null) return;
      if (leaf.exact ? t === targetText : t.includes(targetText)) count++;
    } else {
      if (candidate.getAttribute('data-testid') === leaf.testId) count++;
    }
  });
  return count === 1;
}

// Nearest ancestor an AI codegen step can scope a selector to, so a button
// that appears in both a header and a modal doesn't collide -- but only if
// scoping to it actually disambiguates the predicted leaf. A testid on a
// wrapper around an entire repeated list (e.g. every item's "Proceed" button
// sharing one ancestor testid) looks landmark-shaped but doesn't disambiguate
// anything; verifying before accepting is what getContainerHint and
// getTextAnchoredXPath already do elsewhere in this file -- this was the one
// place that discipline was missing.
function getLandmark(
  el: Element,
  leaf: Extract<LeafPrediction, { needsScope: true }>
): LandmarkDescriptor | undefined {
  if (leaf.kind === 'other') return undefined;
  let node = el.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < 10) {
    const role = node.getAttribute('role') || undefined;
    const testId = node.getAttribute('data-testid') || undefined;
    const tag = node.tagName.toLowerCase();
    const isLandmark =
      Boolean(testId) ||
      (role && LANDMARK_ROLES.includes(role)) ||
      LANDMARK_TAGS.includes(tag) ||
      node.getAttribute('aria-modal') === 'true';
    if (isLandmark && landmarkVerifies(node, leaf)) {
      return { tag, role, testId, id: node.id || undefined, ariaLabel: node.getAttribute('aria-label') || undefined };
    }
    node = node.parentElement;
    depth++;
  }
  return undefined;
}

// Native interactive tags carry an implicit ARIA role even with no `role`
// attribute (a plain <button> IS role="button"). Without this, a button and a
// heading that happen to share the same visible text ("Login") both end up
// with role: undefined, so the role+text leaf in locatorBuilder gets skipped
// and codegen falls back to a bare getByText that matches both — exactly the
// strict-mode violation this recorder exists to prevent.
const IMPLICIT_BUTTON_TYPES = ['submit', 'button', 'reset'];

function getImplicitRole(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
      return el.hasAttribute('href') ? 'link' : undefined;
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input': {
      const type = (el as HTMLInputElement).type;
      if (IMPLICIT_BUTTON_TYPES.includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    default:
      return undefined;
  }
}

// Cheap same-page check: would a role+text selector for this element currently
// match more than one node? Scans by visible text + IMPLICIT role rather than
// same tag, so a heading and a same-named button are correctly compared (they
// differ in role, so they don't collide) and two differently-tagged elements
// that really do share both role and text (e.g. a native <button> and a
// <div role="button">) are correctly flagged as ambiguous.
// innerText reflects only RENDERED text -- the browser returns "" for an
// element with no layout box (display:none, the exact CSS a responsive
// desktop/mobile nav pair uses to hide one copy), so scanning by innerText
// alone makes a hidden duplicate invisible to every uniqueness check in this
// file (getContainerHint's countHasTextMatches and getLandmark's
// landmarkVerifies included, not just this one). textContent doesn't have
// that blind spot.
function getRenderedOrFullText(el: Element): string {
  const innerText = (el as HTMLElement).innerText;
  return innerText && innerText.trim() ? innerText : el.textContent || '';
}

// normalizeText keeps the comparison consistent regardless of which source
// (innerText vs the textContent fallback) supplied it.
function getComparableText(el: Element): string | undefined {
  const normalized = normalizeText(getRenderedOrFullText(el));
  return normalized ? normalized.slice(0, 80) : undefined;
}

function hasSameRoleAndText(el: Element, role: string | undefined, text: string | undefined): DuplicateCheck {
  if (!text) return { ambiguous: false, hiddenDuplicate: false };
  const normalizedText = normalizeText(text).slice(0, 80);
  const matches: Element[] = [el];
  document.querySelectorAll('body *').forEach((candidate) => {
    if (candidate === el) return;
    if (getComparableText(candidate) !== normalizedText) return;
    // Only filter by role when el itself has one -- that's the only case
    // buildLeaf can ever use a role+name locator (getByRole(role, {name})),
    // where a different-role candidate genuinely isn't a collision. When el
    // has no role (e.g. a plain <li>), buildLeaf can only ever fall through
    // to a role-agnostic getByText, which collides with ANY matching text
    // regardless of the other element's role -- filtering by role here would
    // hide a real duplicate just because it happens to be a <button> instead
    // of a <li>.
    if (role && getImplicitRole(candidate) !== role) return;
    matches.push(candidate);
  });
  return classifyMatches(el, matches);
}

// Real-world markup often duplicates "unique" ids across e.g. two copies of the
// same widget (light/dark theme, two dropdown menus). getElementById hides this;
// querySelectorAll does not. If an id-based selector would be non-unique, flag it.
interface DuplicateCheck {
  ambiguous: boolean;
  // At least one other DOM match exists, but every one of them is currently
  // hidden (e.g. a mobile-nav duplicate sitting alongside the visible one the
  // user actually clicked). Not a real conflict a hasText scope needs to
  // resolve, but Playwright's strict mode still counts hidden matches, so the
  // emitted locator needs a `.filter({ visible: true })` guard regardless.
  hiddenDuplicate: boolean;
}

function classifyMatches(el: Element, matches: Element[]): DuplicateCheck {
  const others = matches.filter((m) => m !== el);
  return { ambiguous: others.length > 0, hiddenDuplicate: others.length > 0 && !others.some(isVisible) };
}

function hasDuplicateId(el: Element): DuplicateCheck {
  if (!el.id) return { ambiguous: false, hiddenDuplicate: false };
  const matches = Array.from(document.querySelectorAll(`[id="${CSS.escape(el.id)}"]`));
  return classifyMatches(el, matches);
}

// data-testid is supposed to be a developer-guaranteed unique hook, but a shared
// component with a hardcoded default testid prop (never overridden per usage) is
// a real, common bug — e.g. a Login button and a Forgot Password button both
// getting data-testid="customButton" from the same base component.
function hasDuplicateTestId(el: Element): DuplicateCheck {
  const testId = el.getAttribute('data-testid');
  if (!testId) return { ambiguous: false, hiddenDuplicate: false };
  const matches = Array.from(document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`));
  return classifyMatches(el, matches);
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// A common responsive pattern (e.g. separate desktop/mobile nav markup, one
// hidden via a CSS breakpoint) means an element can have an exact DOM
// duplicate that a user never sees. Playwright's strict mode still counts
// that hidden duplicate as a match, so ambiguity has to be checked against
// on-screen reality, not just node count.
function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Classes that describe layout/spacing rather than a specific component — not
// useful as a scoping selector since they're shared by unrelated elements.
const UTILITY_CLASS_PATTERN =
  /^(?:d-|flex\b|w-\d|h-\d|m[trblxy]?-?\d|p[trblxy]?-?\d|f-\d|fs-\d|btn(?:-|$)|active$|show$|hide$|hidden$|col(?:-|$)|row$|container(?:-|$)|text-|bg-|border|justify-|align-|position-|float-)/i;

function getMeaningfulClassName(el: Element): string | undefined {
  for (const cls of Array.from(el.classList)) {
    if (cls.length > 2 && !UTILITY_CLASS_PATTERN.test(cls)) return cls;
  }
  return undefined;
}

// How many elements matching `selector` currently have hasText-matching text
// (Playwright's hasText is a substring check, so we mirror that here). This is
// the same query buildContainerScope will emit, so checking it at record time
// tells us whether that locator will actually be unique before we commit to it.
function countHasTextMatches(selector: string, text: string): number {
  let count = 0;
  document.querySelectorAll(selector).forEach((node) => {
    const nodeText = normalizeText(getRenderedOrFullText(node));
    if (nodeText.includes(text)) count++;
  });
  return count;
}

// Given a selector already known to uniquely match `fullText`, shrink the
// hasText string to the shortest word-prefix that's still unique. A card/row
// container's full text is usually every field concatenated (name + address +
// city + zip, say) — the moment any sibling field changes, a hasText on the
// whole blob breaks. A short, human-recognizable prefix (e.g. "Warehouse
// FreightSmith" instead of the full address) is far more stable and is
// exactly what a person tightening a flaky selector by hand would do.
function shrinkToUniqueText(selector: string, fullText: string): string {
  const words = fullText.split(' ');
  for (let n = 1; n < words.length; n++) {
    const candidate = words.slice(0, n).join(' ');
    if (countHasTextMatches(selector, candidate) === 1) return candidate;
  }
  return fullText;
}

// Nearest ancestor whose (class-or-tag + its own visible text) uniquely identifies
// it across the whole page. Repeated card/grid layouts (a list of plain <div>
// cards, not <li>/<tr>) are extremely common and were previously missed entirely
// because the old version only recognized semantic list containers — walking up
// by structure instead of by tag name catches those too. Nearest-first keeps the
// resulting locator as tight and stable as possible.
function getContainerHint(el: Element): ElementDescriptor['containerHint'] {
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < 10) {
    const text = normalizeText((node as HTMLElement).innerText || '').slice(0, 100);
    if (text) {
      const className = getMeaningfulClassName(node);
      const selector = className ? `.${CSS.escape(className)}` : node.tagName.toLowerCase();
      if (countHasTextMatches(selector, text) === 1) {
        const shortText = shrinkToUniqueText(selector, text);
        return { tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || undefined, text: shortText, className };
      }
    }
    node = node.parentElement;
    depth++;
  }
  return undefined;
}

function buildElementDescriptor(el: Element): ElementDescriptor {
  const tag = el.tagName.toLowerCase();
  const role = getImplicitRole(el);
  const ariaLabel = el.getAttribute('aria-label') || undefined;
  const nearbyText = getNearbyText(el);
  const fullText = (el as HTMLElement).innerText?.trim();
  const text = fullText?.slice(0, 80) || undefined;
  const textTruncated = Boolean(fullText && fullText.length > 80);
  const roleText = hasSameRoleAndText(el, role, text);
  const testId = hasDuplicateTestId(el);
  const id = hasDuplicateId(el);
  const roleTextAmbiguous = roleText.ambiguous;
  const testIdAmbiguous = testId.ambiguous;
  const ambiguous = roleTextAmbiguous || testIdAmbiguous || id.ambiguous;
  const hiddenDuplicate = roleText.hiddenDuplicate || testId.hiddenDuplicate || id.hiddenDuplicate;
  // Only worth computing when nothing else is going to save this element: a
  // testid or a clean role+name already beats any xpath, and containerHint
  // scoping only kicks in when ambiguous anyway. Anchored xpath exists for the
  // remaining gap -- no testid, no unambiguous role+name/text, and (checked
  // below via containerHint) no CSS class anywhere up the tree either.
  const needsXPathFallback = !el.getAttribute('data-testid') && (!role || !text || roleTextAmbiguous);
  const anchoredXPath = needsXPathFallback ? getTextAnchoredXPath(el) : undefined;

  // Predicts which leaf buildLeaf will choose server-side, so getLandmark can
  // verify a candidate ancestor against that SAME leaf instead of guessing.
  const leaf = resolveLeafPrediction({
    testId: el.getAttribute('data-testid') || undefined,
    testIdAmbiguous,
    role,
    text,
    ariaLabel,
    roleTextAmbiguous,
    tag,
    nearbyText,
    textTruncated,
    xpathIsAnchored: Boolean(anchoredXPath),
  });

  return {
    tag,
    id: el.id || undefined,
    name: (el as HTMLInputElement).name || undefined,
    type: (el as HTMLInputElement).type || undefined,
    role,
    ariaLabel,
    text,
    textTruncated,
    css: getCssSelector(el),
    xpath: anchoredXPath ?? getXPath(el),
    xpathIsAnchored: Boolean(anchoredXPath),
    nearbyText,
    testId: el.getAttribute('data-testid') || undefined,
    landmark: leaf.needsScope ? getLandmark(el, leaf) : undefined,
    ambiguous,
    testIdAmbiguous,
    roleTextAmbiguous,
    hiddenDuplicate,
    containerHint: ambiguous ? getContainerHint(el) : undefined,
  };
}

function send(action: RecordedAction) {
  chrome.runtime.sendMessage({ type: 'RECORD_ACTION', action }).catch(() => {
    // Popup/background not ready or not recording; safe to drop.
  });
}

document.addEventListener(
  'click',
  (e) => {
    const raw = e.target;
    if (!(raw instanceof Element)) return;
    const interactive = raw.closest(
      'button, a, [role="button"], input[type="checkbox"], input[type="radio"], input[type="submit"], [onclick]'
    );
    const target = interactive ?? raw;
    send({
      action: 'click',
      timestamp: Date.now(),
      url: location.href,
      element: buildElementDescriptor(target),
    });
  },
  true
);

document.addEventListener(
  'change',
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
      return;
    }
    const tag = el.tagName.toLowerCase();
    send({
      action: tag === 'select' ? 'select' : 'input',
      timestamp: Date.now(),
      url: location.href,
      element: buildElementDescriptor(el),
      value: el.value,
    });
  },
  true
);
