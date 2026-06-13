import { useEffect, useMemo, useRef, useState } from 'react';
import type { Recording, RecordingState, Step } from '@/lib/types';
import {
  getRecording,
  getScreenshot,
  listStepsForRecording,
} from '@/lib/storage';
import { send } from '@/lib/messages';

const NARRATION_DEBOUNCE_MS = 250;

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '00:00';
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function StepThumbnail({ screenshotId }: { screenshotId?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!screenshotId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    getScreenshot(screenshotId).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [screenshotId]);

  if (!url) {
    return (
      <div className="aspect-[16/9] w-full rounded-md border border-dashed border-slate-200 bg-slate-100" />
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="aspect-[16/9] w-full rounded-md border border-slate-200 object-cover"
      loading="lazy"
    />
  );
}

function StepRow({
  step,
  index,
  onDelete,
}: {
  step: Step;
  index: number;
  onDelete: () => void;
}) {
  const description = step.customDescription ?? step.description;
  return (
    <div className="group rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-blue-600 text-[10px] font-semibold text-white">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
          {description}
        </div>
        <button
          onClick={onDelete}
          className="flex-none rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-600"
          title="Delete step (recoverable from editor)"
          aria-label="Delete step"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          >
            <path d="M2 2 L10 10 M10 2 L2 10" />
          </svg>
        </button>
      </div>
      {step.notes && (
        <div className="mb-2 rounded border-l-2 border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-900">
          {step.notes}
        </div>
      )}
      <StepThumbnail screenshotId={step.screenshotId} />
      {step.url && step.type === 'navigate' && (
        <div className="mt-2 truncate text-[11px] text-slate-400">
          {step.url}
        </div>
      )}
    </div>
  );
}

export function SidePanel() {
  const [state, setState] = useState<RecordingState | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [narrationDraft, setNarrationDraft] = useState('');
  const [narrationStatus, setNarrationStatus] = useState<
    'idle' | 'pending' | 'attached'
  >('idle');
  const [, forceTick] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepListEndRef = useRef<HTMLDivElement | null>(null);

  const isRecording = !!state?.activeRecordingId;

  // Initial load + state subscription.
  useEffect(() => {
    refreshState();
    const onMsg = (msg: unknown) => {
      const m = msg as
        | { type: 'RECORDING_STATE_CHANGED'; state: RecordingState }
        | { type: 'STEPS_CHANGED'; recordingId: string }
        | { type: 'NARRATION_CLEARED' };
      if (m?.type === 'RECORDING_STATE_CHANGED') {
        setState(m.state);
      } else if (m?.type === 'STEPS_CHANGED') {
        reloadSteps(m.recordingId);
      } else if (m?.type === 'NARRATION_CLEARED') {
        setNarrationDraft('');
        setNarrationStatus('attached');
        setTimeout(() => setNarrationStatus('idle'), 1200);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    const onStorageChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== 'local' || !changes.recordingState) return;
      const next = changes.recordingState.newValue as
        | RecordingState
        | undefined;
      if (next) setState(next);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active recording id changes, reload the recording + steps.
  useEffect(() => {
    if (!state?.activeRecordingId) {
      setRecording(null);
      setSteps([]);
      return;
    }
    reloadSteps(state.activeRecordingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.activeRecordingId]);

  // Hydrate the textarea from pending narration on panel open.
  useEffect(() => {
    if (!state) return;
    const text = state.pendingNarration?.text ?? '';
    if (text !== narrationDraft) {
      setNarrationDraft(text);
      setNarrationStatus(text ? 'pending' : 'idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.pendingNarration?.arrivedAt]);

  // Tick once a second to keep the timer fresh.
  useEffect(() => {
    if (!isRecording) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isRecording]);

  // Auto-scroll to the latest step as new steps arrive.
  useEffect(() => {
    stepListEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [steps.length]);

  async function refreshState() {
    const reply = (await send<{ state: RecordingState }>({ type: 'GET_STATE' }))
      .state;
    setState(reply);
  }

  async function reloadSteps(recordingId: string) {
    const rec = await getRecording(recordingId);
    setRecording(rec);
    if (rec) setSteps(await listStepsForRecording(rec.id));
  }

  async function start() {
    await send({ type: 'START_RECORDING' });
    await refreshState();
  }

  async function stop() {
    await send({ type: 'STOP_RECORDING' });
    await refreshState();
  }

  function openEditor() {
    if (!recording) return;
    const url =
      chrome.runtime.getURL('src/editor/index.html') +
      `?id=${encodeURIComponent(recording.id)}`;
    chrome.tabs.create({ url });
  }

  function deleteStep(stepId: string) {
    // Optimistic remove for instant feedback. SW does the real soft-delete on
    // its captureChain (race-safe vs concurrent appendStep), then broadcasts
    // STEPS_CHANGED — our handler reloads from IDB and confirms.
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
    void send({ type: 'DELETE_STEP', stepId }).catch(() => {
      // Rollback by reloading from IDB.
      if (recording) reloadSteps(recording.id);
    });
  }

  function onNarrationChange(value: string) {
    setNarrationDraft(value);
    setNarrationStatus(value.trim() ? 'pending' : 'idle');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void send({ type: 'NARRATION_PENDING', text: value }).catch(() => {});
    }, NARRATION_DEBOUNCE_MS);
  }

  function clearNarration() {
    setNarrationDraft('');
    setNarrationStatus('idle');
    void send({ type: 'NARRATION_PENDING', text: '' }).catch(() => {});
  }

  const narrationAge = useMemo(() => {
    if (!state?.pendingNarration) return null;
    return Date.now() - state.pendingNarration.arrivedAt;
  }, [state?.pendingNarration]);

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${
                isRecording ? 'animate-pulse bg-red-500' : 'bg-slate-300'
              }`}
            />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {isRecording ? 'REC' : 'IDLE'}
            </span>
            <span className="text-xs tabular-nums text-slate-400">
              {formatElapsed(state?.startedAt ?? null)}
            </span>
            <span className="text-xs text-slate-400">·</span>
            <span className="text-xs text-slate-500">
              {steps.length} step{steps.length === 1 ? '' : 's'}
            </span>
          </div>
          {isRecording ? (
            <button
              onClick={stop}
              className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
            >
              Start
            </button>
          )}
        </div>
        {recording && (
          <div className="mt-1 truncate text-[11px] text-slate-500">
            {recording.name}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!isRecording && steps.length === 0 ? (
          <div className="mt-8 px-4 text-center text-sm text-slate-400">
            Press <kbd className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-700">Start</kbd> or use your keyboard shortcut to begin.
            Steps appear here in real time as you click and type.
          </div>
        ) : steps.length === 0 ? (
          <div className="mt-8 px-4 text-center text-sm text-slate-400">
            Click and type on the page. Steps appear here as they're captured.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <StepRow
                key={s.id}
                step={s}
                index={i}
                onDelete={() => deleteStep(s.id)}
              />
            ))}
            <div ref={stepListEndRef} />
          </div>
        )}
      </div>

      {!isRecording && recording && steps.length > 0 && (
        <div className="border-t border-slate-200 bg-white px-3 py-3">
          <div className="text-xs text-slate-500">
            Recording stopped — {steps.length} step
            {steps.length === 1 ? '' : 's'} captured
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={openEditor}
              className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open in editor
            </button>
            <button
              onClick={start}
              className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              New recording
            </button>
          </div>
        </div>
      )}

      {isRecording && (
        <div className="sticky bottom-0 border-t border-slate-200 bg-white p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Narration for last step
            </label>
            <span
              className={`text-[10px] font-medium uppercase tracking-wide ${
                narrationStatus === 'pending'
                  ? 'text-indigo-600'
                  : narrationStatus === 'attached'
                    ? 'text-emerald-600'
                    : 'text-slate-300'
              }`}
            >
              {narrationStatus === 'pending'
                ? `Buffered · ${Math.floor((narrationAge ?? 0) / 1000)}s`
                : narrationStatus === 'attached'
                  ? 'Attached ✓'
                  : 'Idle'}
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={narrationDraft}
            onChange={(e) => onNarrationChange(e.target.value)}
            placeholder="Click around, then narrate. Text attaches to the click you just made — flushes on the next click."
            rows={3}
            className={`w-full resize-none rounded-md border-2 bg-white px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:outline-none ${
              narrationStatus === 'pending'
                ? 'border-indigo-400 ring-2 ring-indigo-100'
                : 'border-slate-200 focus:border-blue-400'
            }`}
          />
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
            <span>
              Hold Wispr Flow's hotkey and narrate continuously. Each click cuts the buffer onto the previous click.
            </span>
            {narrationDraft && (
              <button
                onClick={clearNarration}
                className="text-slate-400 hover:text-red-600"
              >
                clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
