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
  name?: string;
  nameAmbiguous: boolean;
  type?: string;
  nearbyText?: string;
  textTruncated: boolean;
  xpathIsAnchored: boolean;
}): LeafPrediction {
  if (ctx.testId && !ctx.testIdAmbiguous) return { needsScope: false };
  if (
    ['input', 'select', 'textarea'].includes(ctx.tag) &&
    !['radio', 'checkbox'].includes(ctx.type ?? '') &&
    ctx.name &&
    !ctx.nameAmbiguous
  ) {
    return { needsScope: false };
  }
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
// alone makes a hidden duplicate invisible to getLandmark's landmarkVerifies.
// textContent doesn't have that blind spot. (getContainerHint / countHasTextMatches
// now go through hasTextValue instead, which is pure textContent for a
// different reason -- matching Playwright's hasText exactly.)
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
  if (!text) return { ambiguous: false, hiddenDuplicate: false, count: 0 };
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
  // Total matches, including `el` itself -- "how many elements on the page
  // this locator would resolve to" (self-inclusive, same semantics
  // countXPathMatches already has). Feeds the review page's locator
  // candidate list (buildLocatorCandidates below); the ambiguous/
  // hiddenDuplicate flags above are all buildLeaf itself needs.
  count: number;
}

function classifyMatches(el: Element, matches: Element[]): DuplicateCheck {
  const others = matches.filter((m) => m !== el);
  return { ambiguous: others.length > 0, hiddenDuplicate: others.length > 0 && !others.some(isVisible), count: matches.length };
}

function hasDuplicateId(el: Element): DuplicateCheck {
  if (!el.id) return { ambiguous: false, hiddenDuplicate: false, count: 0 };
  const matches = Array.from(document.querySelectorAll(`[id="${CSS.escape(el.id)}"]`));
  return classifyMatches(el, matches);
}

// data-testid is supposed to be a developer-guaranteed unique hook, but a shared
// component with a hardcoded default testid prop (never overridden per usage) is
// a real, common bug — e.g. a Login button and a Forgot Password button both
// getting data-testid="customButton" from the same base component.
function hasDuplicateTestId(el: Element): DuplicateCheck {
  const testId = el.getAttribute('data-testid');
  if (!testId) return { ambiguous: false, hiddenDuplicate: false, count: 0 };
  const matches = Array.from(document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`));
  return classifyMatches(el, matches);
}

// A form control's `name` attribute is the sturdiest hook it has: unlike visible
// text it survives copy edits, and unlike a <select>'s "text" (its entire
// concatenated option list) it stays small and stable. Only useful when the
// tag+name pair is actually unique on the page — radio/checkbox groups
// deliberately share one name across every option, so those come back ambiguous
// and buildLeaf falls through to another strategy.
function hasDuplicateName(el: Element): DuplicateCheck {
  const name = (el as HTMLInputElement).name;
  if (!name || !['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) {
    return { ambiguous: false, hiddenDuplicate: false, count: 0 };
  }
  const tag = el.tagName.toLowerCase();
  const matches = Array.from(document.querySelectorAll(`${tag}[name="${CSS.escape(name)}"]`));
  return classifyMatches(el, matches);
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// The exact string Playwright's `.filter({ hasText })` / getByText will test at
// run time. Playwright's `elementText` concatenates descendant text with NO
// separator between block elements, strips zero-width chars, then collapses
// whitespace (see playwright-core elementText + normalizeWhiteSpace). innerText
// disagrees whenever adjacent block children have no whitespace text node
// between them:
//   <div>Warehouse</div><div>Ace Hardware</div>
//   innerText   -> "Warehouse Ace Hardware"   (layout inserts a break)
//   textContent -> "WarehouseAce Hardware"    (what hasText actually sees)
// Validating a hasText candidate against innerText therefore accepts strings
// ("Warehouse Ace") that match 0 elements at run time. Every uniqueness check
// feeding buildContainerScope must use this instead. textContent also carries
// text from display:none nodes, which Playwright's strict mode counts too, so
// this is strictly better than the old innerText-first approach for predicting
// hasText — no hidden-duplicate blind spot.
function hasTextValue(el: Element): string {
  // Playwright also strips U+200B / U+00AD before matching; skipped here since
  // they turn up in card/row text vanishingly rarely and the only cost is the
  // recorder picking a slightly longer hasText prefix.
  return normalizeText(el.textContent || '');
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

// How many elements matching `selector` currently have hasText-matching text.
// Playwright's hasText is a case-insensitive substring check against the
// concatenated-textContent value (hasTextValue) — NOT innerText — so we mirror
// exactly that here. This is the same query buildContainerScope will emit, so
// checking it at record time tells us whether that locator will actually be
// unique (and will match at all) before we commit to it.
function countHasTextMatches(selector: string, text: string): number {
  const needle = text.toLowerCase();
  let count = 0;
  document.querySelectorAll(selector).forEach((node) => {
    if (hasTextValue(node).toLowerCase().includes(needle)) count++;
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
    // Seed from what Playwright's hasText will actually see (concatenated
    // textContent, no block separators), so the word-prefixes shrinkToUniqueText
    // slices are words that truly sit adjacent at match time. innerText here
    // produced phantom prefixes like "Warehouse Ace" for
    // <div>Warehouse</div><div>Ace Hardware</div> that matched 0 at run time.
    const text = hasTextValue(node).slice(0, 100);
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

// Only realistic for same-origin iframes: window.frameElement gives the
// actual <iframe> DOM node in the PARENT document when same-origin, which
// getCssSelector can compute a real selector for (it walks purely via
// el.parentElement/el.tagName, so it works fine on a node from a different
// document than the one this script happens to be running in). Cross-origin,
// frameElement is null and there is no other way to identify which <iframe>
// this is from the inside -- that case is reported (crossOrigin: true) rather
// than guessed at here; the LLM gets a best-effort frameUrl hint instead (see
// SYSTEM_PROMPT in anthropic.ts).
// Computed once per script instance: a content script never survives a frame
// navigation, so the frame chain can't change out from under a cached value.
let frameChainCache: ElementDescriptor['frame'] | undefined | null = null;

function getFrameChain(): ElementDescriptor['frame'] | undefined {
  if (frameChainCache !== null) return frameChainCache ?? undefined;
  if (window === window.top) {
    frameChainCache = undefined;
    return undefined;
  }
  const chain: string[] = [];
  let win: Window = window;
  let crossOrigin = false;
  while (win !== win.top) {
    let frameEl: Element | null;
    try {
      frameEl = win.frameElement;
    } catch {
      frameEl = null;
    }
    if (!frameEl) {
      crossOrigin = true;
      break;
    }
    chain.unshift(getCssSelector(frameEl));
    win = win.parent;
  }
  frameChainCache = { selectorChain: crossOrigin ? [] : chain, crossOrigin, frameUrl: location.href };
  return frameChainCache;
}

function countCssMatches(css: string): number {
  try {
    return document.querySelectorAll(css).length;
  } catch {
    return 0;
  }
}

// Same quote/escape convention as locatorBuilder.ts's escapeStr+quoted
// (backend/src/services/locatorBuilder.ts) -- these expressions are meant to
// be pasted straight into a locatorOverride and used verbatim there, so they
// need to look and behave exactly like the ones the server builds.
function exprQuote(s: string): string {
  return `'${normalizeText(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Every viable way to point at this element, each with a real match count --
// not just the one buildLeaf would auto-pick server-side. Shown on the
// review page so QA can see the tradeoffs and pick one, or type their own.
// Deliberately more permissive than buildLeaf about what counts as a
// "candidate": an ambiguous one (count > 1) is still listed, just not
// marked isDefault -- the count itself is the signal, hiding it would defeat
// the point. Skipped entirely for a cross-origin-iframe element: there's no
// trustworthy frame selector to build any of these on top of (same reasoning
// suggestedLocator itself already applies).
function buildLocatorCandidates(
  ctx: {
    tag: string;
    css: string;
    xpath?: string;
    xpathIsAnchored: boolean;
    testIdAttr?: string;
    testIdCount: number;
    name?: string;
    type?: string;
    nameCount: number;
    role?: string;
    ariaLabel?: string;
    text?: string;
    textTruncated: boolean;
    roleTextCount: number;
    textOnlyCount: number;
    frame: ElementDescriptor['frame'];
  }
): LocatorCandidate[] {
  if (ctx.frame?.crossOrigin) return [];
  const framePrefix =
    ctx.frame && ctx.frame.selectorChain.length > 0
      ? `page${ctx.frame.selectorChain.map((s) => `.frameLocator(${exprQuote(s)})`).join('')}`
      : 'page';

  const candidates: LocatorCandidate[] = [];
  if (ctx.testIdAttr) {
    candidates.push({ kind: 'testId', expr: `${framePrefix}.getByTestId(${exprQuote(ctx.testIdAttr)})`, count: ctx.testIdCount });
  }
  if (['input', 'select', 'textarea'].includes(ctx.tag) && !['radio', 'checkbox'].includes(ctx.type ?? '') && ctx.name) {
    candidates.push({
      kind: 'name',
      expr: `${framePrefix}.locator(${exprQuote(`${ctx.tag}[name="${ctx.name}"]`)})`,
      count: ctx.nameCount,
    });
  }
  if (ctx.role && (ctx.text || ctx.ariaLabel)) {
    candidates.push({
      kind: 'role',
      expr: `${framePrefix}.getByRole(${exprQuote(ctx.role)}, { name: ${exprQuote(ctx.ariaLabel || ctx.text!)} })`,
      count: ctx.roleTextCount,
    });
  }
  if (ctx.text) {
    candidates.push({
      kind: 'text',
      expr: `${framePrefix}.getByText(${exprQuote(ctx.text)}, { exact: ${!ctx.textTruncated} })`,
      count: ctx.textOnlyCount,
    });
  }
  candidates.push({ kind: 'css', expr: `${framePrefix}.locator(${exprQuote(ctx.css)})`, count: countCssMatches(ctx.css) });
  if (ctx.xpathIsAnchored && ctx.xpath) {
    candidates.push({
      kind: 'xpath',
      expr: `${framePrefix}.locator(${exprQuote(`xpath=${ctx.xpath}`)})`,
      count: countXPathMatches(ctx.xpath),
    });
  }

  const uniqueIdx = candidates.findIndex((c) => c.count === 1);
  const defaultIdx = uniqueIdx >= 0 ? uniqueIdx : 0;
  if (candidates[defaultIdx]) candidates[defaultIdx] = { ...candidates[defaultIdx], isDefault: true };
  return candidates;
}

function buildElementDescriptor(el: Element): ElementDescriptor {
  const tag = el.tagName.toLowerCase();
  const role = getImplicitRole(el);
  const ariaLabel = el.getAttribute('aria-label') || undefined;
  const testIdAttr = el.getAttribute('data-testid') || undefined;
  const nearbyText = getNearbyText(el);
  const fullText = (el as HTMLElement).innerText?.trim();
  const text = fullText?.slice(0, 80) || undefined;
  const textTruncated = Boolean(fullText && fullText.length > 80);
  const roleText = hasSameRoleAndText(el, role, text);
  const testId = hasDuplicateTestId(el);
  const id = hasDuplicateId(el);
  const nameDup = hasDuplicateName(el);
  const name = (el as HTMLInputElement).name || undefined;
  const type = (el as HTMLInputElement).type || undefined;
  const nameAmbiguous = nameDup.ambiguous;
  const roleTextAmbiguous = roleText.ambiguous;
  const testIdAmbiguous = testId.ambiguous;
  // A form control we'll key off `name` for: its own visibility duplicate (a
  // responsive form rendered twice, one breakpoint-hidden) still needs the
  // .filter({ visible: true }) guard, exactly as for the testId/id strategies.
  const nameChosen =
    ['input', 'select', 'textarea'].includes(tag) &&
    !['radio', 'checkbox'].includes(type ?? '') &&
    Boolean(name) &&
    !nameAmbiguous;
  const ambiguous = roleTextAmbiguous || testIdAmbiguous || id.ambiguous;
  const hiddenDuplicate =
    roleText.hiddenDuplicate ||
    testId.hiddenDuplicate ||
    id.hiddenDuplicate ||
    (nameChosen && nameDup.hiddenDuplicate);
  // Only worth computing when nothing else is going to save this element: a
  // testid or a clean role+name already beats any xpath, and containerHint
  // scoping only kicks in when ambiguous anyway. Anchored xpath exists for the
  // remaining gap -- no testid, no unambiguous role+name/text, and (checked
  // below via containerHint) no CSS class anywhere up the tree either.
  const needsXPathFallback = !testIdAttr && (!role || !text || roleTextAmbiguous);
  const anchoredXPath = needsXPathFallback ? getTextAnchoredXPath(el) : undefined;
  const css = getCssSelector(el);
  const xpath = anchoredXPath ?? getXPath(el);
  const xpathIsAnchored = Boolean(anchoredXPath);
  const frame = getFrameChain();
  // A pure text-only count (no role filter) for the getByText candidate --
  // hasSameRoleAndText already does exactly this when called with no role.
  const textOnlyCount = text ? hasSameRoleAndText(el, undefined, text).count : 0;
  const locatorCandidates = buildLocatorCandidates({
    tag,
    css,
    xpath,
    xpathIsAnchored,
    testIdAttr,
    testIdCount: testId.count,
    name,
    type,
    nameCount: nameDup.count,
    role,
    ariaLabel,
    text,
    textTruncated,
    roleTextCount: roleText.count,
    textOnlyCount,
    frame,
  });

  // Predicts which leaf buildLeaf will choose server-side, so getLandmark can
  // verify a candidate ancestor against that SAME leaf instead of guessing.
  const leaf = resolveLeafPrediction({
    testId: testIdAttr,
    testIdAmbiguous,
    role,
    text,
    ariaLabel,
    roleTextAmbiguous,
    tag,
    name,
    nameAmbiguous,
    type,
    nearbyText,
    textTruncated,
    xpathIsAnchored: Boolean(anchoredXPath),
  });

  return {
    tag,
    id: el.id || undefined,
    name,
    type,
    nameAmbiguous,
    role,
    ariaLabel,
    text,
    textTruncated,
    css,
    xpath,
    xpathIsAnchored,
    nearbyText,
    testId: testIdAttr,
    landmark: leaf.needsScope ? getLandmark(el, leaf) : undefined,
    ambiguous,
    testIdAmbiguous,
    roleTextAmbiguous,
    hiddenDuplicate,
    containerHint: ambiguous ? getContainerHint(el) : undefined,
    frame,
    locatorCandidates,
  };
}

function send(action: RecordedAction) {
  chrome.runtime.sendMessage({ type: 'RECORD_ACTION', action }).catch(() => {
    // Popup/background not ready or not recording; safe to drop.
  });
}

// Element picker: lets the review screen ask "what does QA want to point at"
// against a LIVE page (retargeting a step, or picking the element for a new
// step) instead of a hand-edited selector string. Independent of recording —
// active any time background sends ENTER_PICK_MODE, whether or not a
// recording is in progress.
//
// Two-state, not one: `pickModeActive` means the session is live (banner
// shown) but clicks behave normally -- QA needs to click through the app
// first to reach a target that doesn't exist yet (open a dropdown, submit a
// step, navigate to another page entirely). Only `pickArmed` (set by the
// banner's "Target next click" button) makes the *next* click the pick.
// Because a real navigation can happen while just browsing, and a fresh page
// load resets all of this module's state, background.ts re-sends
// ENTER_PICK_MODE after every navigation for as long as the session is
// active -- enterPickMode() is written to be safely re-entrant for that.
let pickModeActive = false;
let pickArmed = false;
let pickRequestId = '';
let pickBanner: HTMLElement | undefined;
let pickHoverTarget: Element | undefined;
let pickHoverPrevOutline = '';

function pickInteractiveTarget(el: Element): Element {
  return (
    el.closest('button, a, [role="button"], input, select, textarea, [onclick]') ?? el
  );
}

function onPickMouseOver(e: MouseEvent) {
  const raw = e.target;
  if (!(raw instanceof Element)) return;
  const target = pickInteractiveTarget(raw);
  if (target === pickHoverTarget) return;
  if (pickHoverTarget) (pickHoverTarget as HTMLElement).style.outline = pickHoverPrevOutline;
  pickHoverTarget = target;
  pickHoverPrevOutline = (target as HTMLElement).style.outline;
  (target as HTMLElement).style.outline = '2px solid #0969da';
}

function clearHover() {
  if (!pickHoverTarget) return;
  (pickHoverTarget as HTMLElement).style.outline = pickHoverPrevOutline;
  pickHoverTarget = undefined;
}

function renderPickBanner() {
  if (!pickBanner) return;
  pickBanner.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = pickArmed
    ? 'AI Test Recorder — click the element to use.'
    : 'AI Test Recorder — get to the right screen, then click "Target next click".';
  const btn = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      marginLeft: '10px',
      border: '1px solid #fff',
      background: 'transparent',
      color: '#fff',
      borderRadius: '4px',
      padding: '3px 9px',
      cursor: 'pointer',
      font: 'inherit',
    } satisfies Partial<CSSStyleDeclaration>);
    b.addEventListener('click', onClick);
    return b;
  };
  pickBanner.appendChild(text);
  if (pickArmed) {
    pickBanner.appendChild(btn('Stop targeting', disarmPick));
  } else {
    pickBanner.appendChild(btn('Target next click', armPick));
  }
  pickBanner.appendChild(btn('Cancel', cancelPick));
}

function armPick() {
  pickArmed = true;
  document.addEventListener('mouseover', onPickMouseOver, true);
  renderPickBanner();
}

function disarmPick() {
  pickArmed = false;
  clearHover();
  document.removeEventListener('mouseover', onPickMouseOver, true);
  renderPickBanner();
}

// Local teardown only -- does not tell background to stop re-arming (a real
// navigation calls this indirectly by just... not being called at all, since
// the module reloads; see enterPickMode). Cancel is what tells background.
function exitPickMode() {
  pickModeActive = false;
  disarmPick();
  pickRequestId = '';
  pickBanner?.remove();
  pickBanner = undefined;
}

function cancelPick() {
  chrome.runtime.sendMessage({ type: 'CANCEL_PICK', requestId: pickRequestId }).catch(() => {});
  exitPickMode();
}

// Re-entrant: background calls this again after every navigation for the
// life of the session, since a fresh page load wipes this module's state.
function enterPickMode(requestId: string) {
  pickModeActive = true;
  pickArmed = false;
  pickRequestId = requestId;
  if (!pickBanner) {
    pickBanner = document.createElement('div');
    Object.assign(pickBanner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      background: '#0969da',
      color: '#fff',
      font: '13px -apple-system, sans-serif',
      padding: '8px 14px',
      textAlign: 'center',
    } satisfies Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(pickBanner);
  }
  renderPickBanner();
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === 'ENTER_PICK_MODE') enterPickMode(message.requestId);
});

// Only semantically meaningful keys, not every keystroke: character input is
// already captured wholesale by the 'change' listener's recorded `value`
// (Playwright fills a value in one shot, so per-keystroke replay would add
// noise with no codegen benefit). Enter/Escape/Tab are the ones a flow can
// depend on with no corresponding click/change event of their own.
const RECORDED_KEYS = new Set(['Enter', 'Escape', 'Tab']);

document.addEventListener(
  'keydown',
  (e) => {
    if (pickModeActive) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelPick();
      }
      return;
    }
    if (!RECORDED_KEYS.has(e.key)) return;
    const target = e.target;
    send({
      action: 'keydown',
      timestamp: Date.now(),
      url: location.href,
      element: target instanceof Element ? buildElementDescriptor(target) : undefined,
      value: e.key === 'Tab' && e.shiftKey ? 'Shift+Tab' : e.key,
    });
  },
  true
);

document.addEventListener(
  'click',
  (e) => {
    const raw = e.target;
    if (!(raw instanceof Element)) return;
    if (pickArmed) {
      e.preventDefault();
      e.stopPropagation();
      const target = pickInteractiveTarget(raw);
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKED',
        requestId: pickRequestId,
        element: buildElementDescriptor(target),
        url: location.href,
      }).catch(() => {});
      exitPickMode();
      return;
    }
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
    if (pickModeActive) return;
    const el = e.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
      return;
    }
    // A file input's .value is browser-redacted to "C:\fakepath\<name>" for
    // security -- there is no JS API that exposes the real absolute path.
    // Record what we can (the descriptor + the filename as a display-only
    // label) and let the human supply the real path on the review screen.
    if (el instanceof HTMLInputElement && el.type === 'file') {
      send({
        action: 'upload',
        timestamp: Date.now(),
        url: location.href,
        element: buildElementDescriptor(el),
        value: el.files?.[0]?.name ?? '',
      });
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
