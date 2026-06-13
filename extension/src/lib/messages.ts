import type { CaptureEvent, RecordingState } from './types';

export type Message =
  | { type: 'GET_STATE' }
  | { type: 'STATE_RESULT'; state: RecordingState }
  | { type: 'START_RECORDING'; name?: string }
  | { type: 'STOP_RECORDING' }
  | { type: 'CAPTURE'; event: CaptureEvent }
  | { type: 'RECORDING_STATE_CHANGED'; state: RecordingState }
  | { type: 'OPEN_EDITOR'; recordingId: string }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'STEPS_CHANGED'; recordingId: string }
  | { type: 'DELETE_STEP'; stepId: string }
  | { type: 'NARRATION_PENDING'; text: string }
  | { type: 'NARRATION_CLEARED' }
  | { type: 'PING' }
  | { type: 'PONG' };

export function send<T = unknown>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}
