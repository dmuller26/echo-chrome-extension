export type StepType = 'click' | 'type' | 'submit' | 'navigate' | 'note';

export interface CapturedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureEvent {
  type: StepType;
  description: string;
  value?: string;
  selector?: string;
  rect?: CapturedRect;
  /** Heading text of the nearest enclosing section, if any. */
  context?: string;
  url: string;
  title: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  timestamp: number;
}

/** A redaction rectangle on a step's screenshot. Coords are 0..1 fractions of
 * the screenshot's intrinsic dimensions, so they survive any later resize. */
export interface Overlay {
  type: 'redact';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Validation outcome reported by Claude Code's `/echo-process` skill after
 * re-running the recorded selectors against the live app. */
export interface StepValidation {
  status: 'pass' | 'fail' | 'unverified';
  validatedAt: number;
  /** Free-form note from the validator (e.g., "selector still matches but
   * label changed from 'Save' to 'Save changes'"). */
  notes?: string;
}

/** Proposed rewrite of a step's description / notes coming back from
 * `/echo-process`. Stays alongside the original until the user accepts or
 * rejects it in the editor — never overwrites the user's text silently. */
export interface StepPolishProposal {
  description?: string;
  notes?: string;
  /** Epoch ms the proposal was generated. */
  proposedAt: number;
}

export interface Step extends CaptureEvent {
  id: string;
  recordingId: string;
  index: number;
  screenshotId?: string;
  customDescription?: string;
  /** Free-form prose attached to the step, rendered between title and image. */
  notes?: string;
  overlays?: Overlay[];
  /** Set when the step is soft-deleted; non-null means it lives in Recently
   * deleted and is hidden from the active list / HTML export. */
  deletedAt?: number;
  /** Latest validation result from `/echo-process`. Cleared when accepted
   * (the timestamp + status survives in the recording's history if needed). */
  validation?: StepValidation;
  /** Pending polish proposal awaiting user accept/reject in the editor. */
  polishProposal?: StepPolishProposal;
}

export interface Recording {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  stepIds: string[];
  /** Soft-deleted step ids, ordered by most-recently-deleted first. */
  deletedStepIds: string[];
  /** Pending title proposal from `/echo-process`. */
  titleProposal?: RecordingTitleProposal;
  /** Last time a `/echo-process` output was applied. */
  lastProcessedAt?: number;
}

/** ----- Claude Code handoff schema (v1) -----
 *
 * The extension writes input.json + screenshots/ to
 * `~/Downloads/echo/handoffs/<recordingId>/`. The user runs
 * `/echo-process <recordingId>` in Claude Code; the skill writes output.json
 * back to the same folder. The extension reads output.json via a file picker.
 *
 * Bumping schemaVersion is a breaking change — the skill must check it. */

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export interface HandoffStepInput {
  id: string;
  index: number;
  type: StepType;
  /** What the guide currently shows the reader (customDescription wins). */
  description: string;
  /** Original auto-generated description, preserved so the skill can see what
   * the recorder produced before user edits. */
  originalDescription: string;
  notes?: string;
  selector?: string;
  url: string;
  value?: string;
  context?: string;
  viewport: { width: number; height: number };
  /** Relative path inside the handoff folder, e.g. "screenshots/step-03.png".
   * Omitted for steps that have no screenshot (notes / failed captures). */
  screenshotPath?: string;
  timestamp: number;
}

export interface HandoffInput {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  recordingId: string;
  recordingName: string;
  createdAt: number;
  exportedAt: number;
  /** Optional repo context the user wants the polish pass to consider — lets
   * the skill prefer terminology used in the codebase. */
  repoHint?: string;
  steps: HandoffStepInput[];
}

export interface HandoffStepOutput {
  id: string;
  validation?: StepValidation;
  polish?: { description?: string; notes?: string };
}

export interface HandoffOutput {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  recordingId: string;
  generatedAt: number;
  suggestedTitle?: string;
  steps: HandoffStepOutput[];
}

export interface PendingNarration {
  text: string;
  /** Epoch ms when the textarea contents were last received. Used by the side
   * panel to render an "age" indicator on the buffered narration. */
  arrivedAt: number;
}

/** Suggested-title proposal from `/echo-process`. Same shape as polish: lives
 * on the recording until accepted/rejected. */
export interface RecordingTitleProposal {
  title: string;
  proposedAt: number;
}

export interface RecordingState {
  activeRecordingId: string | null;
  /** All tabs being captured. Starts as just the originating tab; grows when
   * tabs are spawned from a member of this set (e.g., OAuth popups). */
  tabIds: number[];
  startedAt: number | null;
  /** Side panel narration buffer.
   *
   * Semantics: post-narration alignment — text accumulates while the user
   * narrates *after* a click. When the NEXT click is captured, the SW takes
   * the buffer's current contents and attaches them as `notes` on the
   * PREVIOUSLY-captured click step (the one being narrated about), then
   * clears the buffer. On stop, any remaining buffer flushes to the final
   * click step, or falls through to a standalone `note` step if no clicks
   * happened. */
  pendingNarration: PendingNarration | null;
}
