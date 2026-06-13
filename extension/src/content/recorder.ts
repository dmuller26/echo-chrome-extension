/**
 * Content script recorder. Listens for clicks and form changes, computes a
 * description and bounding rect for each, and forwards to the service worker.
 *
 * Active state is read from chrome.storage.local — when the tab is in the
 * recording set (resolved via PING to the background), we capture events.
 *
 * Loaded both as a static content script (manifest content_scripts) and via
 * `chrome.scripting.executeScript` from the SW on recording start (to cover
 * tabs that were already open when the extension was installed/reloaded).
 * The idempotency guard below ensures listeners are only attached once even
 * when both injection paths fire on the same frame.
 */

import {
  describeElement,
  describeStep,
  buildSelector,
  findHeadingContext,
} from '@/lib/describe';
import type { CaptureEvent, RecordingState } from '@/lib/types';

declare global {
  interface Window {
    __echoRecorderLoaded?: boolean;
  }
}

if (window.__echoRecorderLoaded) {
  // Already attached in this isolated world (this frame). Skip.
} else {
  window.__echoRecorderLoaded = true;

const STATE_KEY = 'recordingState';

let activeForThisTab = false;

async function refreshActiveFlag(): Promise<void> {
  try {
    const { [STATE_KEY]: state } = await chrome.storage.local.get(STATE_KEY);
    const s = state as RecordingState | undefined;
    if (!s || !s.activeRecordingId) {
      activeForThisTab = false;
      return;
    }
    // Ask the background to confirm we're the active tab.
    const reply = (await chrome.runtime.sendMessage({ type: 'PING' })) as
      | { activeForThisTab: boolean }
      | undefined;
    activeForThisTab = !!reply?.activeForThisTab;
  } catch {
    activeForThisTab = false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATE_KEY]) {
    refreshActiveFlag();
  }
});

refreshActiveFlag();

/**
 * Walk up the frame chain to compute this frame's offset within the top frame's
 * viewport. Required for `all_frames: true` so iframe click rects line up with
 * the screenshot, which always captures the top frame.
 *
 * Returns null when the chain crosses a cross-origin boundary anywhere — in
 * that case we omit the rect entirely and the screenshot is captured without
 * a highlight overlay.
 */
function getFrameOffset(): { x: number; y: number } | null {
  try {
    if (window === window.top) return { x: 0, y: 0 };
    let win: Window = window;
    let totalX = 0;
    let totalY = 0;
    let depth = 0;
    while (win !== win.top && depth < 8) {
      const fe = win.frameElement;
      if (!fe) return null;
      const r = fe.getBoundingClientRect();
      totalX += r.x;
      totalY += r.y;
      win = win.parent as Window;
      depth++;
    }
    return { x: totalX, y: totalY };
  } catch {
    // Cross-origin access threw somewhere in the chain.
    return null;
  }
}

function rectFor(el: Element) {
  const r = el.getBoundingClientRect();
  const offset = getFrameOffset();
  if (!offset) return undefined;
  return {
    x: r.x + offset.x,
    y: r.y + offset.y,
    width: r.width,
    height: r.height,
  };
}

function baseEvent(): Omit<CaptureEvent, 'type' | 'description'> {
  return {
    url: location.href,
    title: document.title,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timestamp: Date.now(),
  };
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea', 'label'].includes(tag)) return true;
  const role = el.getAttribute('role');
  if (
    role &&
    ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'].includes(
      role,
    )
  ) {
    return true;
  }
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

function findInteractiveAncestor(el: Element | null): Element | null {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 6) {
    if (isInteractive(node)) return node;
    node = node.parentElement;
    depth++;
  }
  return el;
}

function isSensitive(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;
  // Light-touch heuristic — we said sensitive-data handling is deferred, but
  // never capture password fields even in v1.
  const autocomplete = el.getAttribute('autocomplete') ?? '';
  if (/(^|\s)(current-password|new-password|cc-number|cc-csc)(\s|$)/.test(autocomplete)) {
    return true;
  }
  return false;
}

function send(event: CaptureEvent): void {
  chrome.runtime.sendMessage({ type: 'CAPTURE', event }).catch(() => {
    // Service worker may have just woken up; one failure is fine.
  });
}

document.addEventListener(
  'click',
  (e) => {
    if (!activeForThisTab) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const el = findInteractiveAncestor(target) ?? target;
    if (isSensitive(el)) return;
    const label = describeElement(el);
    const context = findHeadingContext(el);
    send({
      ...baseEvent(),
      type: 'click',
      description: describeStep('click', label, undefined, context),
      selector: buildSelector(el),
      rect: rectFor(el),
      context: context ?? undefined,
    });
  },
  true,
);

document.addEventListener(
  'change',
  (e) => {
    if (!activeForThisTab) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isSensitive(target)) return;

    let value = '';
    let type: 'type' | 'click' = 'type';

    if (target instanceof HTMLInputElement) {
      if (target.type === 'checkbox' || target.type === 'radio') {
        type = 'click';
      } else {
        value = target.value;
      }
    } else if (target instanceof HTMLTextAreaElement) {
      value = target.value;
    } else if (target instanceof HTMLSelectElement) {
      const opt = target.selectedOptions[0];
      value = opt ? opt.label : target.value;
    } else {
      return;
    }

    if (type === 'type' && !value) return;

    const label = describeElement(target);
    const context = findHeadingContext(target);
    send({
      ...baseEvent(),
      type,
      description:
        type === 'type'
          ? describeStep('type', label, value, context)
          : describeStep('click', label, undefined, context),
      value: type === 'type' ? value : undefined,
      selector: buildSelector(target),
      rect: rectFor(target),
      context: context ?? undefined,
    });
  },
  true,
);

document.addEventListener(
  'submit',
  (e) => {
    if (!activeForThisTab) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const label = describeElement(target);
    const context = findHeadingContext(target);
    send({
      ...baseEvent(),
      type: 'submit',
      description: describeStep('submit', label, undefined, context),
      selector: buildSelector(target),
      rect: rectFor(target),
      context: context ?? undefined,
    });
  },
  true,
);

} // end idempotency guard
