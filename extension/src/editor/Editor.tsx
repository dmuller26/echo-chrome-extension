import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Overlay, Recording, Step } from '@/lib/types';
import {
  getRecording,
  getScreenshot,
  listStepsForRecording,
  listDeletedStepsForRecording,
  putRecording,
  putStep,
  deleteStep as deleteStepFromDb,
  deleteScreenshot,
} from '@/lib/storage';
import { downloadHtmlGuide } from '@/lib/export';
import {
  exportHandoff,
  parseHandoffOutput,
  applyHandoffOutput,
  type ExportHandoffResult,
} from '@/lib/handoff';

function useRecordingId(): string | null {
  return useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('id');
  }, []);
}

function broadcastStepsChanged(recordingId: string): void {
  void chrome.runtime
    .sendMessage({ type: 'STEPS_CHANGED', recordingId })
    .catch(() => {});
}

interface StepRowProps {
  step: Step;
  index: number;
  total: number;
  onChange: (s: Step) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}

function StepRow({ step, index, total, onChange, onDelete, onMove }: StepRowProps) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const [redactMode, setRedactMode] = useState(false);
  const [draftRect, setDraftRect] = useState<Overlay | null>(null);
  const dragStart = useRef<{ x: number; y: number; rect: DOMRect } | null>(null);
  const overlayLayerRef = useRef<HTMLDivElement | null>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  useEffect(() => {
    if (!step.screenshotId) {
      setImgUrl(null);
      setImgNatural(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    getScreenshot(step.screenshotId).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setImgUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [step.screenshotId]);

  const description = step.customDescription ?? step.description;
  const overlays = step.overlays ?? [];

  function startDrawing(e: React.MouseEvent<HTMLDivElement>) {
    if (!redactMode) return;
    if (!overlayLayerRef.current) return;
    e.preventDefault();
    const rect = overlayLayerRef.current.getBoundingClientRect();
    dragStart.current = { x: e.clientX, y: e.clientY, rect };
    setDraftRect({
      type: 'redact',
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
      w: 0,
      h: 0,
    });
  }

  function continueDrawing(e: React.MouseEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    const { rect, x, y } = dragStart.current;
    const cx = Math.max(rect.left, Math.min(rect.right, e.clientX));
    const cy = Math.max(rect.top, Math.min(rect.bottom, e.clientY));
    const x0 = Math.min(x, cx);
    const y0 = Math.min(y, cy);
    const x1 = Math.max(x, cx);
    const y1 = Math.max(y, cy);
    setDraftRect({
      type: 'redact',
      x: (x0 - rect.left) / rect.width,
      y: (y0 - rect.top) / rect.height,
      w: (x1 - x0) / rect.width,
      h: (y1 - y0) / rect.height,
    });
  }

  function finishDrawing() {
    if (!draftRect) {
      dragStart.current = null;
      return;
    }
    if (draftRect.w > 0.005 && draftRect.h > 0.005) {
      onChange({ ...step, overlays: [...overlays, draftRect] });
    }
    setDraftRect(null);
    dragStart.current = null;
  }

  function removeOverlay(i: number) {
    const next = overlays.slice();
    next.splice(i, 1);
    onChange({ ...step, overlays: next });
  }

  const renderRects = draftRect ? [...overlays, draftRect] : overlays;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <button
          {...attributes}
          {...listeners}
          className="mt-1 flex-none cursor-grab touch-none rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-500 active:cursor-grabbing"
          aria-label="Drag to reorder"
          title="Drag to reorder"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.6" />
            <circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" />
            <circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" />
            <circle cx="15" cy="18" r="1.6" />
          </svg>
        </button>
        <span className="mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <textarea
            value={description}
            onChange={(e) =>
              onChange({ ...step, customDescription: e.target.value })
            }
            rows={1}
            className="w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-medium text-slate-900 hover:border-slate-200 focus:border-blue-400 focus:bg-white focus:outline-none"
          />
          <textarea
            value={step.notes ?? ''}
            onChange={(e) => onChange({ ...step, notes: e.target.value })}
            placeholder="Add notes — supports **bold**, *italic*, `code`, [links](url)"
            rows={2}
            className="mt-1 w-full resize-y rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-slate-600 placeholder:text-slate-300 hover:border-slate-200 focus:border-blue-400 focus:bg-white focus:outline-none"
          />
          {step.url && (
            <div className="mt-1 flex items-center gap-1 px-2 text-xs text-slate-400">
              <span className="min-w-0 flex-1 truncate">{step.url}</span>
              <button
                onClick={() => onChange({ ...step, url: '' })}
                className="flex-none rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-red-500"
                title="Remove URL"
                aria-label="Remove URL"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M2 2 L8 8 M8 2 L2 8" />
                </svg>
              </button>
            </div>
          )}
          {step.validation && (
            <ValidationBadge
              validation={step.validation}
              onClear={() =>
                onChange({ ...step, validation: undefined })
              }
            />
          )}
          {step.polishProposal && (
            <PolishProposalCard
              currentDescription={description}
              currentNotes={step.notes ?? ''}
              proposal={step.polishProposal}
              onAcceptDescription={(text) =>
                onChange({
                  ...step,
                  customDescription: text,
                  polishProposal: {
                    ...step.polishProposal!,
                    description: undefined,
                  },
                })
              }
              onAcceptNotes={(text) =>
                onChange({
                  ...step,
                  notes: text,
                  polishProposal: {
                    ...step.polishProposal!,
                    notes: undefined,
                  },
                })
              }
              onDismiss={() =>
                onChange({ ...step, polishProposal: undefined })
              }
            />
          )}
        </div>
        <div className="flex flex-none items-center gap-1 text-slate-400">
          <button
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"
            title="Move up"
            aria-label="Move step up"
          >
            ↑
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"
            title="Move down"
            aria-label="Move step down"
          >
            ↓
          </button>
          <button
            onClick={() => setRedactMode((v) => !v)}
            className={`rounded p-1 hover:bg-slate-100 ${
              redactMode ? 'bg-slate-100 text-slate-700' : ''
            }`}
            title={redactMode ? 'Done redacting' : 'Redact regions'}
          >
            ▣
          </button>
          <button
            onClick={onDelete}
            className="rounded p-1 hover:bg-red-50 hover:text-red-600"
            title="Delete step"
          >
            ×
          </button>
        </div>
      </div>

      {imgUrl && (
        <div className="relative mt-4">
          <img
            src={imgUrl}
            alt={`Step ${index + 1} screenshot`}
            onLoad={(e) => {
              const t = e.currentTarget;
              setImgNatural({ w: t.naturalWidth, h: t.naturalHeight });
            }}
            className={`block w-full rounded-lg border border-slate-200 ${
              redactMode ? 'select-none' : ''
            }`}
            draggable={false}
          />
          <div
            ref={overlayLayerRef}
            onMouseDown={startDrawing}
            onMouseMove={continueDrawing}
            onMouseUp={finishDrawing}
            onMouseLeave={finishDrawing}
            className={`absolute inset-0 rounded-lg ${
              redactMode ? 'cursor-crosshair' : 'pointer-events-none'
            }`}
          >
            {renderRects.map((o, i) => {
              const isCommitted = i < overlays.length;
              return (
                <div
                  key={`${i}-${o.x}-${o.y}-${o.w}-${o.h}`}
                  className={`absolute rounded-md ${
                    isCommitted
                      ? 'bg-slate-700/95 ring-1 ring-slate-700'
                      : 'bg-slate-700/60 ring-2 ring-blue-400'
                  }`}
                  style={{
                    left: `${o.x * 100}%`,
                    top: `${o.y * 100}%`,
                    width: `${o.w * 100}%`,
                    height: `${o.h * 100}%`,
                  }}
                >
                  {redactMode && isCommitted && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeOverlay(i);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs text-slate-700 shadow ring-1 ring-slate-300 hover:bg-red-50 hover:text-red-600"
                      title="Remove redaction"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {redactMode && (
            <div className="mt-2 text-xs text-slate-500">
              Drag on the screenshot to add a redaction. Click ▣ above to finish.
              {imgNatural ? '' : ' (Loading image…)'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeletedStepRow({
  step,
  onRestore,
  onPermanentlyDelete,
}: {
  step: Step;
  onRestore: () => void;
  onPermanentlyDelete: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!step.screenshotId) return;
    let cancelled = false;
    let url: string | null = null;
    getScreenshot(step.screenshotId).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setThumbUrl(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [step.screenshotId]);

  const description = step.customDescription ?? step.description;
  const ago = step.deletedAt ? formatAgo(step.deletedAt) : '';

  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          className="h-12 w-20 flex-none rounded border border-slate-200 object-cover"
        />
      ) : (
        <div className="h-12 w-20 flex-none rounded border border-dashed border-slate-200" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-700">{description}</div>
        <div className="text-xs text-slate-400">Deleted {ago}</div>
      </div>
      <button
        onClick={onRestore}
        className="rounded-md border border-slate-200 px-3 py-1 text-sm text-slate-700 hover:border-blue-400 hover:text-blue-700"
        title="Restore step"
      >
        Restore
      </button>
      <button
        onClick={onPermanentlyDelete}
        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
        title="Delete forever"
        aria-label="Delete forever"
      >
        ×
      </button>
    </div>
  );
}

function formatAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

const VALIDATION_STYLE: Record<
  'pass' | 'fail' | 'unverified',
  { dot: string; ring: string; text: string; label: string }
> = {
  pass: {
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-200',
    text: 'text-emerald-700',
    label: 'Validated',
  },
  fail: {
    dot: 'bg-rose-500',
    ring: 'ring-rose-200',
    text: 'text-rose-700',
    label: 'Failed',
  },
  unverified: {
    dot: 'bg-amber-500',
    ring: 'ring-amber-200',
    text: 'text-amber-700',
    label: 'Unverified',
  },
};

function ValidationBadge({
  validation,
  onClear,
}: {
  validation: NonNullable<Step['validation']>;
  onClear: () => void;
}) {
  const s = VALIDATION_STYLE[validation.status];
  return (
    <div
      className={`mt-2 flex items-start gap-2 rounded-md bg-white px-2 py-1.5 text-xs ring-1 ${s.ring}`}
    >
      <span
        className={`mt-1 inline-block h-2 w-2 flex-none rounded-full ${s.dot}`}
      />
      <div className="min-w-0 flex-1">
        <span className={`font-medium ${s.text}`}>{s.label}</span>
        <span className="text-slate-400">
          {' · '}
          {formatAgo(validation.validatedAt)}
        </span>
        {validation.notes && (
          <div className="mt-0.5 text-slate-600">{validation.notes}</div>
        )}
      </div>
      <button
        onClick={onClear}
        className="flex-none rounded p-0.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600"
        title="Dismiss validation result"
        aria-label="Dismiss validation result"
      >
        ×
      </button>
    </div>
  );
}

function PolishProposalCard({
  currentDescription,
  currentNotes,
  proposal,
  onAcceptDescription,
  onAcceptNotes,
  onDismiss,
}: {
  currentDescription: string;
  currentNotes: string;
  proposal: NonNullable<Step['polishProposal']>;
  onAcceptDescription: (text: string) => void;
  onAcceptNotes: (text: string) => void;
  onDismiss: () => void;
}) {
  const hasDescription =
    !!proposal.description &&
    proposal.description.trim().length > 0 &&
    proposal.description.trim() !== currentDescription.trim();
  const hasNotes =
    !!proposal.notes &&
    proposal.notes.trim().length > 0 &&
    proposal.notes.trim() !== currentNotes.trim();

  if (!hasDescription && !hasNotes) {
    return null;
  }

  return (
    <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-medium uppercase tracking-wide text-indigo-700">
          Claude Code suggestion
        </span>
        <button
          onClick={onDismiss}
          className="rounded p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700"
          title="Dismiss all proposals on this step"
          aria-label="Dismiss proposals"
        >
          ×
        </button>
      </div>
      {hasDescription && (
        <div className="mb-2">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">
            Description
          </div>
          <div className="text-slate-500 line-through">
            {currentDescription || <em>(empty)</em>}
          </div>
          <div className="text-slate-900">{proposal.description}</div>
          <div className="mt-1 flex gap-2">
            <button
              onClick={() => onAcceptDescription(proposal.description!)}
              className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-700"
            >
              Accept
            </button>
          </div>
        </div>
      )}
      {hasNotes && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">
            Notes
          </div>
          {currentNotes && (
            <div className="text-slate-500 line-through">{currentNotes}</div>
          )}
          <div className="whitespace-pre-wrap text-slate-900">
            {proposal.notes}
          </div>
          <div className="mt-1 flex gap-2">
            <button
              onClick={() => onAcceptNotes(proposal.notes!)}
              className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-700"
            >
              Accept
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HandoffModal({
  recordingId,
  result,
  onClose,
  onRefresh,
  refreshing,
  refreshMessage,
}: {
  recordingId: string;
  result: ExportHandoffResult | null;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  refreshMessage: string | null;
}) {
  const command = `/echo-process ${recordingId}`;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="max-w-lg rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-slate-900">
          Process with Claude Code
        </h2>
        <p className="mb-4 text-sm text-slate-600">
          {result
            ? `Wrote input.json + ${result.screenshotCount} screenshot${
                result.screenshotCount === 1 ? '' : 's'
              } to:`
            : 'Exporting handoff…'}
        </p>
        {result && (
          <code className="mb-4 block break-all rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">
            ~/Downloads/{result.relativePath}
          </code>
        )}
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Run in Claude Code
        </div>
        <code className="mb-4 block break-all rounded-md bg-slate-900 px-3 py-2 text-xs text-emerald-300">
          {command}
        </code>
        <div className="mb-4 text-xs text-slate-500">
          The skill writes <code>output.json</code> back to the same folder.
          When it's done, click "Refresh from Claude" and pick the file.
        </div>
        {refreshMessage && (
          <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {refreshMessage}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {refreshing ? 'Reading…' : 'Refresh from Claude'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Editor() {
  const recordingId = useRecordingId();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [deletedSteps, setDeletedSteps] = useState<Step[]>([]);
  const [saving, setSaving] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffResult, setHandoffResult] =
    useState<ExportHandoffResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const refreshInputRef = useRef<HTMLInputElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function refresh() {
    if (!recordingId) return;
    const rec = await getRecording(recordingId);
    setRecording(rec);
    if (rec) {
      setSteps(await listStepsForRecording(rec.id));
      setDeletedSteps(await listDeletedStepsForRecording(rec.id));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  if (!recordingId) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center text-slate-500">
        No recording id provided.
      </div>
    );
  }

  if (!recording) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center text-slate-500">
        Loading…
      </div>
    );
  }

  async function updateStep(updated: Step) {
    setSteps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    await putStep(updated);
    broadcastStepsChanged(updated.recordingId);
  }

  async function deleteStep(stepId: string) {
    if (!recording) return;
    const target = steps.find((s) => s.id === stepId);
    if (!target) return;
    const next = steps.filter((s) => s.id !== stepId);
    // Soft-delete: stamp deletedAt and persist; the row stays in IndexedDB
    // so it can be restored from the Recently Deleted section.
    const deletedStep: Step = { ...target, deletedAt: Date.now() };
    await putStep(deletedStep);
    for (let i = 0; i < next.length; i++) {
      if (next[i].index !== i) {
        next[i] = { ...next[i], index: i };
        await putStep(next[i]);
      }
    }
    setSteps(next);
    setDeletedSteps((prev) => [deletedStep, ...prev]);
    const updatedRec: Recording = {
      ...recording,
      stepIds: next.map((s) => s.id),
      deletedStepIds: [stepId, ...recording.deletedStepIds],
      updatedAt: Date.now(),
    };
    setRecording(updatedRec);
    await putRecording(updatedRec);
    broadcastStepsChanged(recording.id);
  }

  async function restoreStep(stepId: string) {
    if (!recording) return;
    const target = deletedSteps.find((s) => s.id === stepId);
    if (!target) return;
    const restored: Step = {
      ...target,
      deletedAt: undefined,
      index: steps.length,
    };
    await putStep(restored);
    const nextActive = [...steps, restored];
    const nextDeleted = deletedSteps.filter((s) => s.id !== stepId);
    setSteps(nextActive);
    setDeletedSteps(nextDeleted);
    const updatedRec: Recording = {
      ...recording,
      stepIds: nextActive.map((s) => s.id),
      deletedStepIds: recording.deletedStepIds.filter((id) => id !== stepId),
      updatedAt: Date.now(),
    };
    setRecording(updatedRec);
    await putRecording(updatedRec);
    broadcastStepsChanged(recording.id);
  }

  async function permanentlyDeleteStep(stepId: string) {
    if (!recording) return;
    const target = deletedSteps.find((s) => s.id === stepId);
    if (!target) return;
    if (
      !window.confirm(
        'Permanently delete this step? This cannot be undone.',
      )
    ) {
      return;
    }
    await deleteStepFromDb(stepId);
    if (target.screenshotId) {
      try {
        await deleteScreenshot(target.screenshotId);
      } catch {
        // Screenshot may have already been cleaned up by step merging.
      }
    }
    const nextDeleted = deletedSteps.filter((s) => s.id !== stepId);
    setDeletedSteps(nextDeleted);
    const updatedRec: Recording = {
      ...recording,
      deletedStepIds: recording.deletedStepIds.filter((id) => id !== stepId),
      updatedAt: Date.now(),
    };
    setRecording(updatedRec);
    await putRecording(updatedRec);
    broadcastStepsChanged(recording.id);
  }

  async function moveStep(stepId: string, dir: -1 | 1) {
    if (!recording) return;
    const i = steps.findIndex((s) => s.id === stepId);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    for (let k = 0; k < next.length; k++) {
      if (next[k].index !== k) {
        next[k] = { ...next[k], index: k };
        await putStep(next[k]);
      }
    }
    setSteps(next);
    const updatedRec: Recording = {
      ...recording,
      stepIds: next.map((s) => s.id),
      updatedAt: Date.now(),
    };
    setRecording(updatedRec);
    await putRecording(updatedRec);
    broadcastStepsChanged(recording.id);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !recording) return;
    const oldIndex = steps.findIndex((s) => s.id === active.id);
    const newIndex = steps.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(steps, oldIndex, newIndex);
    for (let k = 0; k < next.length; k++) {
      if (next[k].index !== k) {
        next[k] = { ...next[k], index: k };
        await putStep(next[k]);
      }
    }
    setSteps(next);
    const updatedRec: Recording = {
      ...recording,
      stepIds: next.map((s) => s.id),
      updatedAt: Date.now(),
    };
    setRecording(updatedRec);
    await putRecording(updatedRec);
    broadcastStepsChanged(recording.id);
  }

  async function renameRecording(name: string) {
    if (!recording) return;
    const updated = { ...recording, name, updatedAt: Date.now() };
    setRecording(updated);
    await putRecording(updated);
  }

  async function exportHtml() {
    if (!recording) return;
    setSaving(true);
    try {
      await downloadHtmlGuide(recording, steps);
    } finally {
      setSaving(false);
    }
  }

  async function processWithClaude() {
    if (!recording) return;
    setHandoffOpen(true);
    setHandoffResult(null);
    setRefreshMessage(null);
    try {
      const result = await exportHandoff(recording, steps);
      setHandoffResult(result);
    } catch (err) {
      setRefreshMessage(`Export failed: ${String(err)}`);
    }
  }

  function pickRefreshFile() {
    refreshInputRef.current?.click();
  }

  async function onRefreshFileChosen(
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file again still fires
    if (!file) return;
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setRefreshMessage('That file is not valid JSON.');
        return;
      }
      const out = parseHandoffOutput(parsed);
      if (typeof out === 'string') {
        setRefreshMessage(out);
        return;
      }
      if (out.recordingId !== recording?.id) {
        setRefreshMessage(
          `output.json is for a different recording (${out.recordingId}).`,
        );
        return;
      }
      const result = await applyHandoffOutput(out);
      if (!result.recordingMatched) {
        setRefreshMessage('Recording not found in storage.');
        return;
      }
      await refresh();
      setRefreshMessage(
        `Applied ${result.touchedStepIds.length} step update${
          result.touchedStepIds.length === 1 ? '' : 's'
        }${result.titleProposed ? ' + a suggested title' : ''}.`,
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function acceptSuggestedTitle() {
    if (!recording?.titleProposal) return;
    const updated: Recording = {
      ...recording,
      name: recording.titleProposal.title,
      titleProposal: undefined,
      updatedAt: Date.now(),
    };
    setRecording(updated);
    await putRecording(updated);
  }

  async function dismissSuggestedTitle() {
    if (!recording?.titleProposal) return;
    const updated: Recording = {
      ...recording,
      titleProposal: undefined,
      updatedAt: Date.now(),
    };
    setRecording(updated);
    await putRecording(updated);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <input
          value={recording.name}
          onChange={(e) => renameRecording(e.target.value)}
          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold text-slate-900 hover:border-slate-200 focus:border-blue-400 focus:bg-white focus:outline-none"
        />
        {recording.titleProposal && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wide text-indigo-700">
                Claude Code suggested title
              </div>
              <div className="text-slate-900">
                {recording.titleProposal.title}
              </div>
            </div>
            <button
              onClick={acceptSuggestedTitle}
              className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-700"
            >
              Use
            </button>
            <button
              onClick={dismissSuggestedTitle}
              className="rounded p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700"
              title="Dismiss suggestion"
              aria-label="Dismiss title suggestion"
            >
              ×
            </button>
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-2 px-2 text-sm text-slate-500">
          <span>
            {steps.length} step{steps.length === 1 ? '' : 's'}
            {recording.lastProcessedAt && (
              <span className="ml-2 text-xs text-slate-400">
                · processed {formatAgo(recording.lastProcessedAt)}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={processWithClaude}
              disabled={steps.length === 0}
              className="rounded-md border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
              title="Export to ~/Downloads/echo/handoffs/<id>/ and run /echo-process in Claude Code"
            >
              Process with Claude Code
            </button>
            <button
              onClick={exportHtml}
              disabled={saving || steps.length === 0}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? 'Exporting…' : 'Export as HTML'}
            </button>
          </div>
        </div>
      </header>

      <input
        ref={refreshInputRef}
        type="file"
        accept="application/json,.json"
        onChange={onRefreshFileChosen}
        className="hidden"
      />

      {handoffOpen && (
        <HandoffModal
          recordingId={recording.id}
          result={handoffResult}
          onClose={() => setHandoffOpen(false)}
          onRefresh={pickRefreshFile}
          refreshing={refreshing}
          refreshMessage={refreshMessage}
        />
      )}

      {steps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-400">
          No steps captured yet. Start a recording from the popup.
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-4">
              {steps.map((s, i) => (
                <StepRow
                  key={s.id}
                  step={s}
                  index={i}
                  total={steps.length}
                  onChange={updateStep}
                  onDelete={() => deleteStep(s.id)}
                  onMove={(dir) => moveStep(s.id, dir)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {deletedSteps.length > 0 && (
        <section className="mt-12">
          <div className="mb-3 flex items-center justify-between px-2">
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
              Recently deleted
            </h2>
            <span className="text-xs text-slate-400">
              {deletedSteps.length} step{deletedSteps.length === 1 ? '' : 's'} ·
              restoring appends to the end of your guide
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {deletedSteps.map((s) => (
              <DeletedStepRow
                key={s.id}
                step={s}
                onRestore={() => restoreStep(s.id)}
                onPermanentlyDelete={() => permanentlyDeleteStep(s.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
