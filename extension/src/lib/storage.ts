import type { Recording, RecordingState, Step } from './types';

const DB_NAME = 'echo';
const DB_VERSION = 1;
const STORE_RECORDINGS = 'recordings';
const STORE_STEPS = 'steps';
const STORE_SCREENSHOTS = 'screenshots';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_STEPS)) {
        const steps = db.createObjectStore(STORE_STEPS, { keyPath: 'id' });
        steps.createIndex('recordingId', 'recordingId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SCREENSHOTS)) {
        db.createObjectStore(STORE_SCREENSHOTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRecording(rec: Recording): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  await reqToPromise(tx.objectStore(STORE_RECORDINGS).put(rec));
}

/** Forward-migrate older Recording records that pre-date deletedStepIds. */
function normalizeRecording(rec: Recording | undefined | null): Recording | null {
  if (!rec) return null;
  if (!Array.isArray(rec.deletedStepIds)) {
    rec.deletedStepIds = [];
  }
  return rec;
}

export async function getRecording(id: string): Promise<Recording | null> {
  const db = await openDB();
  const tx = db.transaction(STORE_RECORDINGS, 'readonly');
  const result = await reqToPromise(tx.objectStore(STORE_RECORDINGS).get(id));
  return normalizeRecording(result as Recording | undefined);
}

export async function listRecordings(): Promise<Recording[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_RECORDINGS, 'readonly');
  const result = await reqToPromise(tx.objectStore(STORE_RECORDINGS).getAll());
  return ((result as Recording[]) ?? [])
    .map((r) => normalizeRecording(r) as Recording)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(
    [STORE_RECORDINGS, STORE_STEPS, STORE_SCREENSHOTS],
    'readwrite',
  );
  const stepsStore = tx.objectStore(STORE_STEPS);
  const idx = stepsStore.index('recordingId');
  const stepKeys: string[] = [];
  const screenshotIds: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursorReq = idx.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const step = cursor.value as Step;
        stepKeys.push(step.id);
        if (step.screenshotId) screenshotIds.push(step.screenshotId);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  for (const k of stepKeys) stepsStore.delete(k);
  const ssStore = tx.objectStore(STORE_SCREENSHOTS);
  for (const k of screenshotIds) ssStore.delete(k);
  tx.objectStore(STORE_RECORDINGS).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putStep(step: Step): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_STEPS, 'readwrite');
  await reqToPromise(tx.objectStore(STORE_STEPS).put(step));
}

export async function getStep(id: string): Promise<Step | null> {
  const db = await openDB();
  const tx = db.transaction(STORE_STEPS, 'readonly');
  const result = await reqToPromise(tx.objectStore(STORE_STEPS).get(id));
  return (result as Step) ?? null;
}

export async function deleteStep(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_STEPS, 'readwrite');
  await reqToPromise(tx.objectStore(STORE_STEPS).delete(id));
}

export async function listStepsForRecording(recordingId: string): Promise<Step[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_STEPS, 'readonly');
  const idx = tx.objectStore(STORE_STEPS).index('recordingId');
  const result = await reqToPromise(idx.getAll(IDBKeyRange.only(recordingId)));
  return ((result as Step[]) ?? [])
    .filter((s) => !s.deletedAt)
    .sort((a, b) => a.index - b.index);
}

export async function listDeletedStepsForRecording(
  recordingId: string,
): Promise<Step[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_STEPS, 'readonly');
  const idx = tx.objectStore(STORE_STEPS).index('recordingId');
  const result = await reqToPromise(idx.getAll(IDBKeyRange.only(recordingId)));
  return ((result as Step[]) ?? [])
    .filter((s) => !!s.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

export async function putScreenshot(id: string, blob: Blob): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_SCREENSHOTS, 'readwrite');
  await reqToPromise(tx.objectStore(STORE_SCREENSHOTS).put({ id, blob }));
}

export async function getScreenshot(id: string): Promise<Blob | null> {
  const db = await openDB();
  const tx = db.transaction(STORE_SCREENSHOTS, 'readonly');
  const result = (await reqToPromise(tx.objectStore(STORE_SCREENSHOTS).get(id))) as
    | { id: string; blob: Blob }
    | undefined;
  return result?.blob ?? null;
}

export async function deleteScreenshot(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_SCREENSHOTS, 'readwrite');
  await reqToPromise(tx.objectStore(STORE_SCREENSHOTS).delete(id));
}

/* chrome.storage.local — used for the live recording state, which the popup,
 * service worker, and content scripts all read. */
const STATE_KEY = 'recordingState';

export async function getRecordingState(): Promise<RecordingState> {
  const result = await chrome.storage.local.get(STATE_KEY);
  const raw = result[STATE_KEY] as
    | (Partial<RecordingState> & { activeTabId?: number | null })
    | undefined;
  if (!raw) {
    return {
      activeRecordingId: null,
      tabIds: [],
      startedAt: null,
      pendingNarration: null,
    };
  }
  // Forward-migrate older state that used a single `activeTabId`.
  let tabIds: number[] = Array.isArray(raw.tabIds) ? raw.tabIds : [];
  if (tabIds.length === 0 && typeof raw.activeTabId === 'number') {
    tabIds = [raw.activeTabId];
  }
  return {
    activeRecordingId: raw.activeRecordingId ?? null,
    tabIds,
    startedAt: raw.startedAt ?? null,
    pendingNarration: raw.pendingNarration ?? null,
  };
}

export async function setRecordingState(state: RecordingState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export function uid(): string {
  return crypto.randomUUID();
}
