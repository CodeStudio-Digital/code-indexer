
export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

export type RecorderErrorCode =
  | 'denied'
  | 'no-device'
  | 'busy'
  | 'unsupported'
  | 'no-model'
  | 'http'
  | 'empty';
