/**
 * Element-to-description heuristics. Resolves a human-readable label and
 * a reasonably-stable selector for any element interacted with during recording.
 */

const MAX_TEXT_LEN = 60;

function trim(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
}

function visibleText(el: Element): string {
  // innerText respects visibility; textContent does not
  const t = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return trim(t);
}

function roleNoun(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  if (role) return role;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'dropdown';
  if (tag === 'textarea') return 'text area';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type || 'text';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio button';
    if (type === 'submit') return 'submit button';
    if (type === 'button') return 'button';
    return `${type} field`;
  }
  return tag;
}

/** Resolve a human-readable label for the element. */
export function describeElement(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return trim(aria);

  const ariaBy = el.getAttribute('aria-labelledby');
  if (ariaBy) {
    const labelEl = document.getElementById(ariaBy);
    if (labelEl) {
      const t = visibleText(labelEl);
      if (t) return t;
    }
  }

  // For form controls, look up their <label>
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) {
        const t = visibleText(label);
        if (t) return t;
      }
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) {
      const t = visibleText(wrappingLabel);
      if (t) return t;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return trim(el.placeholder);
      if (el.name) return `the ${el.name} ${roleNoun(el)}`;
    }
  }

  const text = visibleText(el);
  if (text) return text;

  const title = el.getAttribute('title');
  if (title) return trim(title);

  // Icon-only / wrapper-divs that have no text of their own — look inside.
  const fromIcon = findIconLabel(el);
  if (fromIcon) return fromIcon;

  const name = el.getAttribute('name');
  if (name) return `the ${name} ${roleNoun(el)}`;

  return `the ${roleNoun(el)}`;
}

/** Look for a label-like attribute or text inside the element's subtree. Used
 * when the element itself is an icon-only button or an empty wrapper, common
 * in modern apps like Tango/Zoom/Google. */
function findIconLabel(el: Element): string | null {
  // Descendant element with an aria-label
  const labelled = el.querySelector('[aria-label]');
  if (labelled) {
    const lbl = labelled.getAttribute('aria-label');
    if (lbl) return trim(lbl);
  }

  // <img alt="...">
  const imgs = el.querySelectorAll('img[alt]');
  for (const img of Array.from(imgs)) {
    const alt = (img as HTMLImageElement).alt;
    if (alt && alt.trim()) return trim(alt);
  }

  // <svg><title>...</title></svg>
  const svgTitle = el.querySelector('svg title');
  if (svgTitle?.textContent) {
    const t = trim(svgTitle.textContent);
    if (t) return t;
  }

  // textContent fallback — innerText respects visibility, textContent doesn't.
  // Useful when descendants have display:none labels for screen readers.
  const tc = el.textContent;
  if (tc) {
    const t = trim(tc);
    if (t) return t;
  }

  // data-* tracking attributes as last-ditch label hints
  for (const attr of [
    'data-tooltip',
    'data-tip',
    'data-label',
    'data-testid',
    'data-test-id',
    'data-tracking-id',
  ]) {
    const v = el.getAttribute(attr);
    if (v && v.trim()) return trim(v);
  }

  return null;
}

/**
 * Build a reasonably-stable selector for the element. We don't need pixel-
 * perfect re-targeting (the screenshot is the canonical artifact), but a
 * selector helps disambiguate steps in the editor.
 */
export function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const path: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 6) {
    const current: Element = node;
    const tag = current.tagName.toLowerCase();
    let segment: string = tag;
    const classList = (current.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((c: string) => c && !c.startsWith('hover:') && !c.includes(':'))
      .slice(0, 2);
    if (classList.length) {
      segment += '.' + classList.map((c: string) => CSS.escape(c)).join('.');
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const sameTagSiblings: Element[] = Array.from(parent.children).filter(
        (c: Element) => c.tagName === current.tagName,
      );
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        segment += `:nth-of-type(${index})`;
      }
    }
    path.unshift(segment);
    node = parent;
  }
  return path.join(' > ');
}

/** Walk up to find the heading text of the nearest enclosing section/region.
 * Returns null when no useful heading is found. */
export function findHeadingContext(el: Element): string | null {
  let ancestor: Element | null = el.parentElement;
  let depth = 0;
  while (ancestor && depth < 8) {
    const labelledby = ancestor.getAttribute('aria-labelledby');
    if (labelledby) {
      const lbl = document.getElementById(labelledby);
      if (lbl) {
        const t = (lbl as HTMLElement).innerText?.trim();
        if (t) return trim(t);
      }
    }
    if (
      ancestor.matches(
        'section, article, aside, nav, [role="region"], [role="dialog"], [role="form"], [role="navigation"]',
      )
    ) {
      const h = ancestor.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
      if (h) {
        const t = (h as HTMLElement).innerText?.trim();
        if (t) return trim(t);
      }
    }
    ancestor = ancestor.parentElement;
    depth++;
  }
  return null;
}

/** Phrase the step body, e.g. "Click **Submit** in *Account*". */
export function describeStep(
  type: 'click' | 'type' | 'submit' | 'navigate',
  label: string,
  value?: string,
  context?: string | null,
): string {
  const ctxSuffix =
    context &&
    context.length < 40 &&
    !label.toLowerCase().includes(context.toLowerCase()) &&
    !context.toLowerCase().includes(label.toLowerCase())
      ? ` in *${context}*`
      : '';
  switch (type) {
    case 'click':
      return `Click **${label}**${ctxSuffix}`;
    case 'type':
      return `Type \`${value ?? ''}\` into **${label}**${ctxSuffix}`;
    case 'submit':
      return `Submit **${label}**${ctxSuffix}`;
    case 'navigate':
      return `Navigate to ${label}`;
  }
}
