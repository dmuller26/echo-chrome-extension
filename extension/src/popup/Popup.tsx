import { useEffect, useState } from 'react';
import type { Recording, RecordingState } from '@/lib/types';
import { listRecordings, deleteRecording } from '@/lib/storage';
import { send } from '@/lib/messages';

function formatRelative(ts: number) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function Popup() {
  const [state, setState] = useState<RecordingState | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [busy, setBusy] = useState(false);
  // Cache the active window id on mount so click handlers can call
  // chrome.sidePanel.open() synchronously — gesture decay across awaits is
  // why the previous version silently failed.
  const [activeWindowId, setActiveWindowId] = useState<number | null>(null);

  async function refresh() {
    const reply = await send<{ state: RecordingState }>({ type: 'GET_STATE' });
    setState(reply.state);
    setRecordings(await listRecordings());
  }

  useEffect(() => {
    refresh();
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs[0]?.windowId !== undefined) {
          setActiveWindowId(tabs[0].windowId);
        }
      })
      .catch(() => {});
    const onMsg = (msg: { type?: string; state?: RecordingState }) => {
      if (msg?.type === 'RECORDING_STATE_CHANGED' && msg.state) {
        setState(msg.state);
        listRecordings().then(setRecordings);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  async function start() {
    // Synchronous side-panel open using the cached windowId — this MUST run
    // before any await, otherwise the user-gesture context is lost.
    if (activeWindowId !== null) {
      chrome.sidePanel
        .open({ windowId: activeWindowId })
        .catch(() => {
          // Already open or denied — non-fatal; SW-side fallback in
          // startRecording will retry.
        });
    }
    setBusy(true);
    try {
      await send({ type: 'START_RECORDING' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await send({ type: 'STOP_RECORDING' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function openEditor(id: string) {
    const url = chrome.runtime.getURL('src/editor/index.html') + `?id=${encodeURIComponent(id)}`;
    chrome.tabs.create({ url });
  }

  function openSidePanel() {
    // Synchronous call from within the click handler. No awaits — the cached
    // windowId is the whole reason this works reliably now.
    if (activeWindowId === null) return;
    chrome.sidePanel
      .open({ windowId: activeWindowId })
      .catch((err) => {
        console.warn('[echo] openSidePanel failed', err);
      });
  }

  async function remove(id: string) {
    await deleteRecording(id);
    setRecordings(await listRecordings());
  }

  const isRecording = !!state?.activeRecordingId;

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              isRecording ? 'bg-red-500 animate-pulse' : 'bg-slate-300'
            }`}
          />
          <h1 className="text-sm font-semibold">Echo</h1>
        </div>
      </header>

      <div className="px-4 py-3">
        {isRecording ? (
          <button
            onClick={stop}
            disabled={busy}
            className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            Stop recording
          </button>
        ) : (
          <button
            onClick={start}
            disabled={busy}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            Start recording
          </button>
        )}
        {isRecording && (
          <p className="mt-2 text-xs text-slate-500">
            Click and type on the page to capture steps. Stop here when done.
          </p>
        )}
        <button
          onClick={openSidePanel}
          className="mt-2 w-full rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-blue-400 hover:text-blue-700"
        >
          Open side panel
        </button>
      </div>

      <div className="border-t border-slate-200">
        <div className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          Recordings
        </div>
        {recordings.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-slate-400">No recordings yet.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto">
            {recordings.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-2"
              >
                <button
                  onClick={() => openEditor(r.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-sm font-medium text-slate-800">
                    {r.name}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {r.stepIds.length} step{r.stepIds.length === 1 ? '' : 's'} ·{' '}
                    {formatRelative(r.updatedAt)}
                  </div>
                </button>
                <button
                  onClick={() => remove(r.id)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                  title="Delete"
                  aria-label="Delete recording"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
