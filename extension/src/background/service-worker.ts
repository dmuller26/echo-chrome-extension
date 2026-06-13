/**
 * Background service worker.
 *
 * Owns recording lifecycle, screenshot capture, and persistence. Receives
 * `CAPTURE` messages from content scripts and webNavigation events for
 * navigation steps.
 */

import {
  getRecordingState,
  setRecordingState,
  putRecording,
  getRecording,
  putStep,
  getStep,
  deleteScreenshot,
  putScreenshot,
  uid,
} from '@/lib/storage';
import { drawHighlight } from '@/lib/highlight';
import type { CaptureEvent, Step, Recording, RecordingState } from '@/lib/types';

let captureChain: Promise<unknown> = Promise.resolve();
const TAB_CAPTURE_THROTTLE_MS = 600;
let lastCaptureAt = 0;

/** Walk backward through `stepIds` to find the most recent click step that
 * isn't `excludeStepId` (the one currently being captured). Returns null if
 * no prior click exists in this recording. Used by the post-narration
 * alignment: when a new click is captured, the dictation buffer flushes to
 * THIS step. */
async function findPreviousClickStep(
  recording: Recording,
  excludeStepId: string | null,
): Promise<Step | null> {
  for (let i = recording.stepIds.length - 1; i >= 0; i--) {
    const id = recording.stepIds[i];
    if (id === excludeStepId) continue;
    const s = await getStep(id);
    if (s && !s.deletedAt && s.type === 'click') return s;
  }
  return null;
}

function broadcastStepsChanged(recordingId: string): void {
  void chrome.runtime
    .sendMessage({ type: 'STEPS_CHANGED', recordingId })
    .catch(() => {
      // No active receiver (no popup/editor/sidepanel open). Harmless.
    });
}

/**
 * Dynamically inject the content-script bundle into a tab's frames. Required
 * because static `content_scripts` only inject on navigation *after* the
 * extension is installed/reloaded — tabs that were already open before then
 * would otherwise be silent. The recorder has an idempotency guard, so this
 * is safe to call even when the static injection already ran.
 */
async function ensureRecorderInjected(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-script.js'],
    });
  } catch (err) {
    // Permission errors on chrome:// or extension pages, or short-lived race
    // when a tab is already closing. Non-fatal.
    console.warn('[echo] ensureRecorderInjected failed', err);
  }
}

/**
 * Soft-delete a step from inside the SW. Goes onto `captureChain` so it
 * doesn't race with concurrent appendStep calls — the side panel can hit ×
 * mid-recording without losing newly-captured steps to a stale-snapshot
 * write.
 */
async function softDeleteStepInSW(stepId: string): Promise<void> {
  const state = await getRecordingState();
  if (!state.activeRecordingId) return;
  const recording = await getRecording(state.activeRecordingId);
  if (!recording) return;
  const step = await getStep(stepId);
  if (!step || step.deletedAt) return;
  if (!recording.stepIds.includes(stepId)) return;

  await putStep({ ...step, deletedAt: Date.now() });

  const remaining = recording.stepIds.filter((id) => id !== stepId);
  recording.stepIds = remaining;
  recording.deletedStepIds = [stepId, ...recording.deletedStepIds];
  recording.updatedAt = Date.now();
  await putRecording(recording);

  // Reindex remaining active steps so subsequent appends pick the right index.
  for (let i = 0; i < remaining.length; i++) {
    const s = await getStep(remaining[i]);
    if (s && s.index !== i) {
      await putStep({ ...s, index: i });
    }
  }

  await refreshBadge();
  broadcastStepsChanged(recording.id);
}

async function clearPendingNarration(): Promise<void> {
  const state = await getRecordingState();
  if (!state.pendingNarration) return;
  const next: RecordingState = { ...state, pendingNarration: null };
  await setRecordingState(next);
  await broadcastState(next);
  void chrome.runtime
    .sendMessage({ type: 'NARRATION_CLEARED' })
    .catch(() => {});
}

async function broadcastState(state: RecordingState) {
  // Notify popup / editor pages that may be open.
  try {
    await chrome.runtime.sendMessage({ type: 'RECORDING_STATE_CHANGED', state });
  } catch {
    // No active receiver; that's fine.
  }
}

async function startRecording(name?: string): Promise<RecordingState> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab to record');

  const recording: Recording = {
    id: uid(),
    name: name?.trim() || defaultName(tab.title ?? tab.url ?? 'Untitled'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stepIds: [],
    deletedStepIds: [],
  };
  await putRecording(recording);

  const state: RecordingState = {
    activeRecordingId: recording.id,
    tabIds: [tab.id],
    startedAt: Date.now(),
    // Always start with no pending narration — never carry over from a prior
    // session that ended unexpectedly.
    pendingNarration: null,
  };
  await setRecordingState(state);
  await broadcastState(state);
  await refreshBadge();

  // Open the side panel for the recorded window. Requires a user gesture
  // context — works for popup-initiated start (button click) and for
  // commands.onCommand keyboard shortcut start; falls back silently for
  // gesture-less paths (none today).
  if (tab.windowId !== undefined) {
    try {
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'src/sidepanel/index.html',
        enabled: true,
      });
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (err) {
      console.warn('[echo] sidePanel.open failed', err);
    }
  }

  // Ensure the recorder is running on the originating tab. Handles the case
  // where the tab was opened before the extension was installed/reloaded —
  // static content_scripts wouldn't have caught it.
  await ensureRecorderInjected(tab.id);

  // Seed an initial navigation step so the guide opens with the starting page.
  if (tab.url) {
    await appendStep({
      type: 'navigate',
      description: `Navigate to ${tab.url}`,
      url: tab.url,
      title: tab.title ?? '',
      devicePixelRatio: 1,
      viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
      timestamp: Date.now(),
    }, tab.id);
  }

  return state;
}

function defaultName(seed: string): string {
  const stamp = new Date().toLocaleString();
  return `${seed.slice(0, 50)} — ${stamp}`;
}

async function stopRecording(): Promise<RecordingState> {
  // Flush whatever's in the narration buffer onto the most recent click
  // (post-narration alignment: the buffer describes the click the user just
  // finished narrating about). If no click ever happened in the recording,
  // fall back to a standalone `note` step so the dictation isn't lost.
  const before = await getRecordingState();
  if (before.activeRecordingId && before.pendingNarration?.text.trim()) {
    const recording = await getRecording(before.activeRecordingId);
    if (recording) {
      const text = before.pendingNarration.text.trim();
      const lastClick = await findPreviousClickStep(recording, null);
      if (lastClick) {
        await putStep({ ...lastClick, notes: text });
      } else {
        const noteStep: Step = {
          id: uid(),
          recordingId: recording.id,
          index: recording.stepIds.length,
          type: 'note',
          description: text,
          notes: undefined,
          url: '',
          title: '',
          devicePixelRatio: 1,
          viewport: { width: 0, height: 0 },
          timestamp: before.pendingNarration.arrivedAt,
        };
        await putStep(noteStep);
        recording.stepIds.push(noteStep.id);
      }
      recording.updatedAt = Date.now();
      await putRecording(recording);
      broadcastStepsChanged(recording.id);
    }
  }

  const state: RecordingState = {
    activeRecordingId: null,
    tabIds: [],
    startedAt: null,
    pendingNarration: null,
  };
  await setRecordingState(state);
  await broadcastState(state);
  await refreshBadge();
  return state;
}

async function appendStep(event: CaptureEvent, tabId: number | undefined): Promise<void> {
  const state = await getRecordingState();
  if (!state.activeRecordingId) return;
  const recording = await getRecording(state.activeRecordingId);
  if (!recording) return;

  // Post-narration alignment. Side panel maintains the buffer; when a new
  // click is captured we flush whatever's in the buffer back onto the
  // PREVIOUS click step (the one the user was narrating). Type/submit/
  // navigate events don't trigger a cut. The flush happens *after* the merge
  // check below so we have the right "previous click" id to target.
  const narration = state.pendingNarration;
  const narrationHasText = !!narration && !!narration.text.trim();
  const flushNarration = narrationHasText && event.type === 'click';

  // Merge: if this is a `type` event arriving immediately after a `click` on the
  // same selector, replace the prior click step in place. The new screenshot
  // shows the typed value in the field, which is what the guide reader needs.
  const lastStepId = recording.stepIds[recording.stepIds.length - 1];
  const lastStep = lastStepId ? await getStep(lastStepId) : null;
  const shouldMerge =
    event.type === 'type' &&
    lastStep &&
    lastStep.type === 'click' &&
    !!event.selector &&
    !!lastStep.selector &&
    event.selector === lastStep.selector;

  let screenshotId: string | undefined;
  if (tabId !== undefined && event.type !== 'navigate') {
    screenshotId = await tryCaptureScreenshot(tabId, event);
  } else if (tabId !== undefined && event.type === 'navigate') {
    screenshotId = await tryCaptureScreenshot(tabId, { ...event, rect: undefined });
  }

  if (shouldMerge && lastStep) {
    if (lastStep.screenshotId && lastStep.screenshotId !== screenshotId) {
      try {
        await deleteScreenshot(lastStep.screenshotId);
      } catch {
        // Best-effort cleanup; non-fatal.
      }
    }
    const merged: Step = {
      ...lastStep,
      ...event,
      id: lastStep.id,
      recordingId: lastStep.recordingId,
      index: lastStep.index,
      screenshotId: screenshotId ?? lastStep.screenshotId,
      // Preserve any user edits the click step accumulated.
      customDescription: lastStep.customDescription,
      notes: lastStep.notes,
      overlays: lastStep.overlays,
    };
    await putStep(merged);
    recording.updatedAt = Date.now();
    await putRecording(recording);
    await refreshBadge();
    broadcastStepsChanged(recording.id);
    return;
  }

  const step: Step = {
    ...event,
    id: uid(),
    recordingId: recording.id,
    index: recording.stepIds.length,
    screenshotId,
    // New click steps start with no notes — narration arrives AFTER and
    // attaches retroactively when the next click captures.
    notes: undefined,
  };

  await putStep(step);
  recording.stepIds.push(step.id);

  // Post-narration flush: this click is "the next click" the user has been
  // narrating toward; the buffer's contents describe the *previous* click.
  if (flushNarration) {
    const prevClick = await findPreviousClickStep(recording, step.id);
    if (prevClick) {
      const text = narration!.text.trim();
      // Overwrite — during recording the user's the only writer. Manual edits
      // happen post-stop in the editor.
      await putStep({ ...prevClick, notes: text });
      await clearPendingNarration();
    }
    // No prior click yet — leave the buffer for the next click that does have
    // a predecessor, or fall through to the orphan-note path on stop.
  }

  recording.updatedAt = Date.now();
  await putRecording(recording);
  await refreshBadge();
  broadcastStepsChanged(recording.id);
}

async function tryCaptureScreenshot(
  tabId: number,
  event: CaptureEvent,
): Promise<string | undefined> {
  // Throttle to respect chrome.tabs.captureVisibleTab's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
  const now = Date.now();
  const wait = Math.max(0, TAB_CAPTURE_THROTTLE_MS - (now - lastCaptureAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return;
    // captureVisibleTab requires the tab to be active in its window.
    if (!tab.active) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await drawHighlight(dataUrl, event.rect, event.devicePixelRatio);
    const id = uid();
    await putScreenshot(id, blob);
    return id;
  } catch (err) {
    console.warn('[echo] capture failed', err);
    return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'GET_STATE': {
          const state = await getRecordingState();
          sendResponse({ type: 'STATE_RESULT', state });
          return;
        }
        case 'START_RECORDING': {
          const state = await startRecording(message.name);
          sendResponse({ type: 'STATE_RESULT', state });
          return;
        }
        case 'STOP_RECORDING': {
          const state = await stopRecording();
          sendResponse({ type: 'STATE_RESULT', state });
          return;
        }
        case 'CAPTURE': {
          const state = await getRecordingState();
          const tabId = sender.tab?.id;
          if (
            state.activeRecordingId &&
            tabId !== undefined &&
            state.tabIds.includes(tabId)
          ) {
            // Serialise captures to keep ordering and avoid screenshot-call races.
            captureChain = captureChain.then(() =>
              appendStep(message.event as CaptureEvent, tabId),
            );
            await captureChain;
          }
          sendResponse({ ok: true });
          return;
        }
        case 'PING': {
          const state = await getRecordingState();
          const tabId = sender.tab?.id;
          sendResponse({
            activeForThisTab:
              !!state.activeRecordingId &&
              tabId !== undefined &&
              state.tabIds.includes(tabId),
          });
          return;
        }
        case 'DELETE_STEP': {
          // Serialise on captureChain so a concurrent appendStep can't lose
          // the new step's id to our stale-recording-snapshot write.
          const stepId = String(message.stepId);
          captureChain = captureChain.then(() => softDeleteStepInSW(stepId));
          await captureChain;
          sendResponse({ ok: true });
          return;
        }
        case 'NARRATION_PENDING': {
          // Side panel sends this on every textarea change (debounced). The
          // textarea is the source of truth — we mirror its full contents.
          const state = await getRecordingState();
          if (!state.activeRecordingId) {
            sendResponse({ ok: false, error: 'no active recording' });
            return;
          }
          const text = String(message.text ?? '');
          if (text.trim().length === 0) {
            // Empty textarea: clear pending narration entirely.
            await clearPendingNarration();
          } else {
            const next: RecordingState = {
              ...state,
              pendingNarration: { text, arrivedAt: Date.now() },
            };
            await setRecordingState(next);
            await broadcastState(next);
          }
          sendResponse({ ok: true });
          return;
        }
        case 'OPEN_SIDE_PANEL': {
          // Manual open from popup. Popup gesture qualifies for sidePanel.open.
          const tabs = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          const tab = tabs[0];
          if (tab?.windowId !== undefined) {
            try {
              await chrome.sidePanel.setOptions({
                tabId: tab.id,
                path: 'src/sidepanel/index.html',
                enabled: true,
              });
              await chrome.sidePanel.open({ windowId: tab.windowId });
              sendResponse({ ok: true });
            } catch (err) {
              sendResponse({ ok: false, error: String(err) });
            }
          } else {
            sendResponse({ ok: false, error: 'no active tab' });
          }
          return;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      console.error('[echo] message handler error', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  // Indicate async response.
  return true;
});

// Track navigations across the recording set so the guide reflects every
// committed top-frame navigation in any recorded tab.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // top frame only
  const state = await getRecordingState();
  if (!state.activeRecordingId || !state.tabIds.includes(details.tabId)) return;
  if (details.transitionType === 'auto_subframe') return;

  // Skip the very first commit at recording start (already seeded in startRecording).
  if (state.startedAt && Date.now() - state.startedAt < 500) return;

  // Allow time for the new page to render before capturing.
  await new Promise((r) => setTimeout(r, 750));

  await appendStep(
    {
      type: 'navigate',
      description: `Navigate to ${details.url}`,
      url: details.url,
      title: '',
      devicePixelRatio: 1,
      viewport: { width: 0, height: 0 },
      timestamp: Date.now(),
    },
    details.tabId,
  );
});

// Expand the recording set when a recorded tab spawns a new tab (target=_blank,
// window.open, OAuth popups). The new tab's openerTabId points at its parent.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id || tab.openerTabId === undefined) return;
  const state = await getRecordingState();
  if (!state.activeRecordingId) return;
  if (!state.tabIds.includes(tab.openerTabId)) return;
  if (state.tabIds.includes(tab.id)) return;
  const updated: RecordingState = {
    ...state,
    tabIds: [...state.tabIds, tab.id],
  };
  await setRecordingState(updated);
  await broadcastState(updated);
  // Newly-spawned tabs typically get static-content-script injection on
  // their initial navigation, but inject defensively in case the tab was
  // pre-created (e.g., about:blank) before navigation commits.
  await ensureRecorderInjected(tab.id);
});

// Drop closed tabs from the set. If the set goes empty, end the recording.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getRecordingState();
  if (!state.activeRecordingId || !state.tabIds.includes(tabId)) return;
  const remaining = state.tabIds.filter((id) => id !== tabId);
  if (remaining.length === 0) {
    await stopRecording();
    return;
  }
  const updated: RecordingState = { ...state, tabIds: remaining };
  await setRecordingState(updated);
  await broadcastState(updated);
});

// Keyboard shortcut entry point. Bind via chrome://extensions/shortcuts.
//
// `chrome.sidePanel.open` requires an active user-gesture context. After even
// a single `await`, that context is gone — so we kick the open SYNCHRONOUSLY
// using `tab.windowId` (provided directly by `commands.onCommand`) before any
// awaits, then do the recording toggle async. The `sidePanel.open` call
// returns a promise we don't await; if it fails (e.g., side panel already
// open), it's harmless.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-recording') return;
  if (tab?.windowId !== undefined) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch(() => {
        // Already open or permission denied — non-fatal.
      });
  }
  void (async () => {
    try {
      const state = await getRecordingState();
      if (state.activeRecordingId) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } catch (err) {
      console.warn('[echo] toggle-recording failed', err);
    }
  })();
});

/** Visual indicator on the toolbar action: red badge with current step count
 * while recording, empty when stopped. Survives service-worker termination. */
async function refreshBadge(): Promise<void> {
  try {
    const state = await getRecordingState();
    if (!state.activeRecordingId) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const recording = await getRecording(state.activeRecordingId);
    const count = recording?.stepIds.length ?? 0;
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch {
    // Best-effort; the action API can be flaky during SW boot.
  }
}

self.addEventListener('install', () => {
  // @ts-expect-error - service worker globals
  self.skipWaiting?.();
});
