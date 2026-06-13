/**
 * Claude Code integration handoff.
 *
 * Round-trips a recording through Claude Code without any Anthropic API call:
 *
 *   1. Editor calls `exportHandoff(recording, steps, opts)` which writes
 *      `~/Downloads/echo/handoffs/<recordingId>/input.json` plus a
 *      sibling `screenshots/step-NN.png` per step (via `chrome.downloads.download`).
 *
 *   2. User opens Claude Code and runs `/echo-process <recordingId>`. The
 *      skill reads the handoff, validates each step (re-driving selectors via
 *      the `/chrome` skill), polishes step descriptions/notes/title using
 *      codebase awareness, and writes `output.json` back to the same folder.
 *
 *   3. Editor reads `output.json` via a file picker and calls
 *      `applyHandoffOutput(...)` which lands `validation` + `polishProposal`
 *      onto each step and `titleProposal` onto the recording. The user accepts
 *      or rejects per-step in the editor.
 *
 * No filesystem path can be read directly from the extension — the file
 * picker step is the only way back in. The download path is fixed so the user
 * always knows where to look. The whole pipeline survives without a native
 * messaging host.
 */

import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffInput,
  type HandoffOutput,
  type HandoffStepInput,
  type Recording,
  type Step,
} from './types';
import {
  getRecording,
  getScreenshot,
  getStep,
  putRecording,
  putStep,
} from './storage';

/** Where the extension writes handoff folders, relative to the user's Chrome
 * downloads directory. Surfaced in the editor modal so the user can paste it. */
export const HANDOFF_DOWNLOADS_BASE = 'echo/handoffs';

/** Pad index to two digits so screenshots sort lexically. */
function padIndex(n: number): string {
  return String(n).padStart(2, '0');
}

function screenshotFilename(step: Step): string {
  return `screenshots/step-${padIndex(step.index)}.png`;
}

function relativeHandoffPath(recordingId: string, leaf: string): string {
  return `${HANDOFF_DOWNLOADS_BASE}/${recordingId}/${leaf}`;
}

async function blobToObjectUrl(blob: Blob): Promise<string> {
  return URL.createObjectURL(blob);
}

/** Trigger a single `chrome.downloads.download`. Returns the download id so
 * the caller can wait for completion if it cares. */
async function downloadAs(blob: Blob, filename: string): Promise<number> {
  const url = await blobToObjectUrl(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      // Don't pop the "Save as" dialog — we want a fixed predictable layout.
      saveAs: false,
      // Overwrite previous handoff exports for the same recording.
      conflictAction: 'overwrite',
    });
    return id;
  } finally {
    // Revoke after a beat — the downloads service grabs the blob synchronously.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export interface ExportHandoffOptions {
  /** Optional repo path the user wants polish to consider. Pass-through to the
   * skill; not interpreted by the extension. */
  repoHint?: string;
}

export interface ExportHandoffResult {
  /** Path under the user's Downloads folder, e.g.
   * "echo/handoffs/abc-123". */
  relativePath: string;
  /** Number of screenshot files written. */
  screenshotCount: number;
}

/**
 * Build the handoff input.json + screenshot files. Triggers one
 * `chrome.downloads.download` per file. Resolves once they've all been kicked
 * off (the actual write is async and happens via Chrome's downloader).
 */
export async function exportHandoff(
  recording: Recording,
  steps: Step[],
  opts: ExportHandoffOptions = {},
): Promise<ExportHandoffResult> {
  if (!chrome.downloads?.download) {
    throw new Error(
      'chrome.downloads is unavailable — extension is missing the "downloads" permission.',
    );
  }

  const inputSteps: HandoffStepInput[] = [];

  // 1. Download screenshots (one per step that has one).
  let screenshotCount = 0;
  for (const step of steps) {
    let screenshotPath: string | undefined;
    if (step.screenshotId) {
      const blob = await getScreenshot(step.screenshotId);
      if (blob) {
        const filename = relativeHandoffPath(
          recording.id,
          screenshotFilename(step),
        );
        await downloadAs(blob, filename);
        screenshotPath = screenshotFilename(step);
        screenshotCount += 1;
      }
    }

    inputSteps.push({
      id: step.id,
      index: step.index,
      type: step.type,
      description: step.customDescription ?? step.description,
      originalDescription: step.description,
      notes: step.notes,
      selector: step.selector,
      url: step.url,
      value: step.value,
      context: step.context,
      viewport: step.viewport,
      screenshotPath,
      timestamp: step.timestamp,
    });
  }

  // 2. Download input.json.
  const input: HandoffInput = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    recordingId: recording.id,
    recordingName: recording.name,
    createdAt: recording.createdAt,
    exportedAt: Date.now(),
    repoHint: opts.repoHint?.trim() || undefined,
    steps: inputSteps,
  };

  const inputBlob = new Blob([JSON.stringify(input, null, 2)], {
    type: 'application/json',
  });
  await downloadAs(
    inputBlob,
    relativeHandoffPath(recording.id, 'input.json'),
  );

  return {
    relativePath: `${HANDOFF_DOWNLOADS_BASE}/${recording.id}`,
    screenshotCount,
  };
}

export interface ApplyHandoffOutputResult {
  /** Step ids that received a polish proposal or validation result. */
  touchedStepIds: string[];
  /** True when output.recordingId matched the recording in IDB. */
  recordingMatched: boolean;
  /** Set when the output had a suggestedTitle different from the current name. */
  titleProposed: boolean;
}

/**
 * Validate a parsed `output.json`. Returns null if the shape doesn't look like
 * a v1 handoff — the editor surfaces the message so users know what's wrong.
 */
export function parseHandoffOutput(raw: unknown): HandoffOutput | string {
  if (!raw || typeof raw !== 'object') return 'Output is not a JSON object.';
  const o = raw as Partial<HandoffOutput>;
  if (o.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    return `Unsupported schemaVersion ${o.schemaVersion} (expected ${HANDOFF_SCHEMA_VERSION}).`;
  }
  if (typeof o.recordingId !== 'string' || !o.recordingId) {
    return 'Output is missing recordingId.';
  }
  if (!Array.isArray(o.steps)) {
    return 'Output is missing steps[].';
  }
  return o as HandoffOutput;
}

/**
 * Land the validator + polish results onto each step (and a title proposal
 * onto the recording). Does NOT overwrite the user's existing description /
 * notes — proposals sit alongside them until accepted.
 */
export async function applyHandoffOutput(
  output: HandoffOutput,
): Promise<ApplyHandoffOutputResult> {
  const recording = await getRecording(output.recordingId);
  if (!recording) {
    return {
      touchedStepIds: [],
      recordingMatched: false,
      titleProposed: false,
    };
  }

  const touched: string[] = [];

  for (const out of output.steps) {
    const step = await getStep(out.id);
    if (!step || step.recordingId !== recording.id) continue;

    let next: Step = step;
    let changed = false;

    if (out.validation) {
      next = { ...next, validation: out.validation };
      changed = true;
    }

    const polishHasContent =
      !!out.polish &&
      ((out.polish.description && out.polish.description.trim().length > 0) ||
        (out.polish.notes && out.polish.notes.trim().length > 0));

    if (polishHasContent) {
      next = {
        ...next,
        polishProposal: {
          description: out.polish?.description?.trim() || undefined,
          notes: out.polish?.notes?.trim() || undefined,
          proposedAt: output.generatedAt,
        },
      };
      changed = true;
    }

    if (changed) {
      await putStep(next);
      touched.push(step.id);
    }
  }

  let titleProposed = false;
  const trimmedTitle = output.suggestedTitle?.trim();
  if (trimmedTitle && trimmedTitle !== recording.name) {
    recording.titleProposal = {
      title: trimmedTitle,
      proposedAt: output.generatedAt,
    };
    titleProposed = true;
  }
  recording.lastProcessedAt = Date.now();
  recording.updatedAt = Date.now();
  await putRecording(recording);

  return {
    touchedStepIds: touched,
    recordingMatched: true,
    titleProposed,
  };
}
