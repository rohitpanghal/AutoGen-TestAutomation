// Deterministic recorder: captures DOM context for each action, never coordinates.
// Recording on/off state lives in the background service worker; this script always
// reports events and lets the background decide whether to keep them.

const SENSITIVE_PATTERN = /pass|token|secret|ssn|credit|card|cvv|pin/i;

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

function getNearbyText(el: Element): string | undefined {
  const label =
    el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
  if (label?.textContent) return label.textContent.trim().slice(0, 100);
  const prev = el.previousElementSibling;
  if (prev?.textContent) return prev.textContent.trim().slice(0, 100);
  return undefined;
}

function isMasked(el: HTMLInputElement): boolean {
  if (el.type === 'password') return true;
  return SENSITIVE_PATTERN.test(`${el.id} ${el.name} ${el.getAttribute('autocomplete') ?? ''}`);
}

const LANDMARK_ROLES = ['dialog', 'main', 'navigation', 'form', 'banner', 'contentinfo', 'region'];
const LANDMARK_TAGS = ['nav', 'header', 'footer', 'form', 'dialog', 'main'];

// Nearest stable ancestor an AI codegen step can scope a selector to, so a
// button that appears in both a header and a modal doesn't collide.
function getLandmark(el: Element): LandmarkDescriptor | undefined {
  let node = el.parentElement;
  while (node) {
    const role = node.getAttribute('role') || undefined;
    const testId = node.getAttribute('data-testid') || undefined;
    const tag = node.tagName.toLowerCase();
    const isLandmark =
      Boolean(testId) ||
      (role && LANDMARK_ROLES.includes(role)) ||
      LANDMARK_TAGS.includes(tag) ||
      node.getAttribute('aria-modal') === 'true';
    if (isLandmark) {
      return { tag, role, testId, id: node.id || undefined, ariaLabel: node.getAttribute('aria-label') || undefined };
    }
    node = node.parentElement;
  }
  return undefined;
}

// Cheap same-page check: would a role+text selector for this element currently
// match more than one node? Lets codegen know when it must scope or disambiguate.
function hasSameRoleAndText(tag: string, role: string | undefined, text: string | undefined): boolean {
  if (!text) return false;
  let count = 0;
  document.querySelectorAll(tag).forEach((candidate) => {
    const candidateText = (candidate as HTMLElement).innerText?.trim().slice(0, 80);
    const candidateRole = candidate.getAttribute('role') || undefined;
    if (candidateText === text && candidateRole === role) count++;
  });
  return count > 1;
}

// Real-world markup often duplicates "unique" ids across e.g. two copies of the
// same widget (light/dark theme, two dropdown menus). getElementById hides this;
// querySelectorAll does not. If an id-based selector would be non-unique, flag it.
function hasDuplicateId(el: Element): boolean {
  if (!el.id) return false;
  return document.querySelectorAll(`[id="${CSS.escape(el.id)}"]`).length > 1;
}

// data-testid is supposed to be a developer-guaranteed unique hook, but a shared
// component with a hardcoded default testid prop (never overridden per usage) is
// a real, common bug — e.g. a Login button and a Forgot Password button both
// getting data-testid="customButton" from the same base component.
function hasDuplicateTestId(el: Element): boolean {
  const testId = el.getAttribute('data-testid');
  if (!testId) return false;
  return document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length > 1;
}

// Nearest ancestor that behaves like a distinct list/menu entry (li, row, menuitem).
// For icon-only controls with no accessible name, this is often the only thing that
// tells two otherwise-identical copies apart — e.g. Playwright's own strict-mode
// error suggests exactly this: .filter({ hasText: '...' }) on the enclosing <li>.
function getContainerHint(el: Element): ElementDescriptor['containerHint'] {
  const container = el.closest('li, tr, [role="listitem"], [role="menuitem"], [role="row"]');
  if (!container || container === el) return undefined;
  const text = (container as HTMLElement).innerText?.trim().slice(0, 100);
  if (!text) return undefined;
  return { tag: container.tagName.toLowerCase(), role: container.getAttribute('role') || undefined, text };
}

function buildElementDescriptor(el: Element): ElementDescriptor {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || undefined;
  const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || undefined;
  const roleTextAmbiguous = hasSameRoleAndText(tag, role, text);
  const testIdAmbiguous = hasDuplicateTestId(el);
  const ambiguous = roleTextAmbiguous || testIdAmbiguous || hasDuplicateId(el);
  return {
    tag,
    id: el.id || undefined,
    name: (el as HTMLInputElement).name || undefined,
    type: (el as HTMLInputElement).type || undefined,
    role,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    text,
    css: getCssSelector(el),
    xpath: getXPath(el),
    nearbyText: getNearbyText(el),
    testId: el.getAttribute('data-testid') || undefined,
    landmark: getLandmark(el),
    ambiguous,
    testIdAmbiguous,
    roleTextAmbiguous,
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
    const masked = el instanceof HTMLInputElement ? isMasked(el) : false;
    send({
      action: tag === 'select' ? 'select' : 'input',
      timestamp: Date.now(),
      url: location.href,
      element: buildElementDescriptor(el),
      value: masked ? '********' : el.value,
      masked,
    });
  },
  true
);
