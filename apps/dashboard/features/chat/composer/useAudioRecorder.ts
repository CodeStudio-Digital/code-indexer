import type { RecorderStatus, RecorderErrorCode } from './recorder-types.js';
export type { RecorderErrorCode } from './recorder-types.js';
/**
 * useAudioRecorder — records mic audio via MediaRecorder, transcribes it via
 * `POST /api/coder/transcribe`, and hands the final text back through
 * `onResult`. The composer mic button (`MicButton`) drives it; composers only
 * wire `onResult → setInput(append)`.
 *
 * State machine: idle → requesting → recording → transcribing → (idle | error)
 *
 * Owns the full lifecycle (permission, recording, base64, network, cleanup) so
 * each composer stays a one-liner. All tracks are stopped on stop/unmount to
 * release the OS mic indicator.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { readDataUrlBase64 } from '../utils.js';
import { transcribeAudio, TranscribeError } from './transcribe-api.js';
import { readMicDeviceId } from './mic-device.js';
import { publishVoiceCapture, clearVoiceCaptureAnalyser, setVoiceCaptureStop } from './voice-capture-store.js';

/** Bound the permission/acquire phase so a hung getUserMedia can't pin the UI. */
const GET_USER_MEDIA_TIMEOUT_MS = 20_000;

/**
 * getUserMedia with a watchdog. If the OS prompt / device hangs past the
 * deadline we reject with an AbortError; a stream that resolves late is stopped
 * so the mic indicator doesn't leak.
 */
function getAudioStream(timeoutMs: number, constraints: MediaStreamConstraints): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('getUserMedia timeout');
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        if (settled) { stream.getTracks().forEach((t) => t.stop()); return; }
        settled = true;
        clearTimeout(timer);
        resolve(stream);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface UseAudioRecorderOpts {
  onResult: (text: string) => void;
  language?: string;
  /** Auto-stop after this long to bound runaway recordings. */
  maxDurationMs?: number;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMimeType(): string | null {
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  if (!MR) return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MR.isTypeSupported(m)) return m;
    } catch { /* isTypeSupported can throw on some impls */ }
  }
  return null;
}

export function useAudioRecorder(opts: UseAudioRecorderOpts) {
  const { onResult, language, maxDurationMs = 120_000 } = opts;
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [errorCode, setErrorCode] = useState<RecorderErrorCode | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Gate for the `onstop` handler: true → transcribe; false → discard. Cleared
  // on unmount so a recording torn down mid-flight doesn't fire a wasted call.
  const transcribeOnStopRef = useRef(true);
  // Web Audio graph powering the live waveform, + ownership of the shared store.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const capturingRef = useRef(false);

  const safeSetStatus = useCallback((s: RecorderStatus) => {
    if (mountedRef.current) setStatus(s);
  }, []);

  // Publish/clear the singleton capture status, but only while THIS instance
  // owns the live recording (guards the dual-mount case).
  const publishCaptureStatus = useCallback((s: RecorderStatus) => {
    if (capturingRef.current) publishVoiceCapture({ status: s });
  }, []);
  const endCapture = useCallback((s: RecorderStatus) => {
    if (capturingRef.current) {
      capturingRef.current = false;
      publishVoiceCapture({ status: s });
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Tear down the analyser/AudioContext and release ownership of the store's
    // analyser (identity-scoped, so a sibling recorder isn't clobbered).
    const a = analyserRef.current;
    if (a) { try { a.disconnect(); } catch { /* noop */ } }
    clearVoiceCaptureAnalyser(a);
    analyserRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => { /* noop */ });
  }, []);

  const fail = useCallback((code: RecorderErrorCode) => {
    if (!mountedRef.current) return;
    setErrorCode(code);
    setStatus('error');
  }, []);

  const handleStop = useCallback(async () => {
    releaseStream();
    if (!transcribeOnStopRef.current) {
      chunksRef.current = [];
      endCapture('idle');
      return;
    }
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    chunksRef.current = [];
    if (blob.size === 0) {
      endCapture('idle');
      fail('empty');
      return;
    }
    publishCaptureStatus('transcribing');
    safeSetStatus('transcribing');
    try {
      const base64 = await readDataUrlBase64(blob);
      const text = await transcribeAudio(base64, mimeRef.current, language);
      endCapture('idle');
      if (!mountedRef.current) return;
      onResult(text);
      setErrorCode(null);
      setStatus('idle');
    } catch (e) {
      endCapture('idle');
      if (e instanceof TranscribeError) fail(e.code);
      else fail('http');
    }
  }, [endCapture, fail, language, onResult, publishCaptureStatus, releaseStream, safeSetStatus]);

  const start = useCallback(async () => {
    if (status === 'recording' || status === 'requesting' || status === 'transcribing') return;
    const mime = pickMimeType();
    if (!mime || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      fail('unsupported');
      return;
    }
    setErrorCode(null);
    safeSetStatus('requesting');
    // Honor the picked OS device (null = system default). `exact` surfaces a
    // gone device as OverconstrainedError → 'no-device' so the user re-picks.
    const deviceId = readMicDeviceId();
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    };
    let stream: MediaStream;
    try {
      stream = await getAudioStream(GET_USER_MEDIA_TIMEOUT_MS, constraints);
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') fail('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') fail('no-device');
      // NotReadableError = mic held by another app; AbortError = hardware error
      // or our watchdog timeout. Both are "busy/unavailable", not "unsupported".
      else if (name === 'NotReadableError' || name === 'AbortError') fail('busy');
      else fail('unsupported');
      return;
    }
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    mimeRef.current = mime;
    chunksRef.current = [];
    transcribeOnStopRef.current = true;
    // Tap an AnalyserNode for the live waveform — non-fatal (recording still
    // works if Web Audio is unavailable). NEVER connect to destination (no
    // playback → no feedback). Released in releaseStream().
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const audioContext = new Ctx();
        // Created after the getUserMedia await → may start suspended (autoplay
        // policy), which freezes the analyser clock. Resume so data flows.
        if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
        const sourceNode = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.7;
        sourceNode.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
      }
    } catch {
      analyserRef.current = null;
    }
    // Construct AND start under one guard: on some Electron/Chromium builds
    // start() can throw even though isTypeSupported passed. Set recorderRef only
    // after start() succeeds so a throw can't leave a half-armed recorder + an
    // open mic stream with status pinned on 'requesting'.
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => { void handleStop(); };
      recorder.start();
    } catch {
      releaseStream();
      recorderRef.current = null;
      fail('unsupported');
      return;
    }
    recorderRef.current = recorder;
    capturingRef.current = true;
    publishVoiceCapture({ status: 'recording', analyser: analyserRef.current });
    safeSetStatus('recording');
    timerRef.current = setTimeout(() => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    }, maxDurationMs);
  }, [fail, handleStop, maxDurationMs, releaseStream, safeSetStatus, status]);

  const stop = useCallback(() => {
    transcribeOnStopRef.current = true;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      transcribeOnStopRef.current = false;
      try {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      } catch { /* noop */ }
      releaseStream();
      endCapture('idle');
    };
  }, [releaseStream, endCapture]);

  // Expose `stop` to the composer-level recording overlay while recording, so
  // its Stop button can end the capture without prop-drilling the recorder.
  useEffect(() => {
    if (status !== 'recording') return;
    setVoiceCaptureStop(stop);
    return () => setVoiceCaptureStop(null);
  }, [status, stop]);

  return { status, errorCode, start, stop };
}
