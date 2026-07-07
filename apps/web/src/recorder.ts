/**
 * Microphone capture for server-side Whisper: MediaRecorder + RMS-based
 * voice-activity detection. Works in every browser with getUserMedia
 * (Chrome, Edge, Firefox, Safari). Recording stops automatically after
 * a stretch of silence once speech has been heard, on maxMs, or manually.
 * Raw audio goes only to Zenith's own /api/v1/stt endpoint, in memory.
 */

const CHECK_MS = 80;
const CALIBRATION_MS = 400; // sample ambient noise before judging speech
const MIN_THRESHOLD = 0.01;

export interface UtteranceHandle {
  /** Finish now and resolve with whatever was recorded. */
  stop: () => void;
  /** Abandon: resolves null. */
  cancel: () => void;
}

export interface RecordOptions {
  /** stop after this much silence following speech (ms) */
  silenceMs?: number;
  /** absolute cap (ms) */
  maxMs?: number;
  onHandle?: (handle: UtteranceHandle) => void;
  /** live speech/silence signal for UI feedback */
  onLevel?: (speaking: boolean) => void;
}

export function recorderSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Records one utterance; resolves null on mic denial or empty capture. */
export async function recordUtterance(options: RecordOptions = {}): Promise<Blob | null> {
  const silenceMs = options.silenceMs ?? 1100;
  const maxMs = options.maxMs ?? 30_000;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return null;
  }

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);

  return new Promise<Blob | null>((resolve) => {
    let heardSpeech = false;
    let silentFor = 0;
    let elapsed = 0;
    let cancelled = false;
    // Adaptive threshold: calibrate against the room's ambient noise so
    // detection works in quiet bedrooms and noisy hostels alike.
    let noisePeak = 0;
    let threshold = MIN_THRESHOLD;

    const cleanup = () => {
      window.clearInterval(vadTimer);
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close();
    };

    recorder.onstop = () => {
      cleanup();
      if (cancelled || chunks.length === 0 || !heardSpeech) return resolve(null);
      resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };

    const vadTimer = window.setInterval(() => {
      elapsed += CHECK_MS;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += (buffer[i] ?? 0) ** 2;
      const rms = Math.sqrt(sum / buffer.length);

      if (elapsed <= CALIBRATION_MS) {
        noisePeak = Math.max(noisePeak, rms);
        threshold = Math.max(MIN_THRESHOLD, noisePeak * 2.2);
        return;
      }

      const speaking = rms >= threshold;
      options.onLevel?.(speaking);

      if (speaking) {
        heardSpeech = true;
        silentFor = 0;
      } else if (heardSpeech) {
        silentFor += CHECK_MS;
      }

      const doneBySilence = heardSpeech && silentFor >= silenceMs;
      const doneByTime = elapsed >= maxMs;
      // Nothing said at all within 8s → give up quietly.
      const doneByNoSpeech = !heardSpeech && elapsed >= 8000;
      if (doneBySilence || doneByTime || doneByNoSpeech) {
        if (recorder.state !== "inactive") recorder.stop();
      }
    }, CHECK_MS);

    options.onHandle?.({
      stop: () => {
        if (recorder.state !== "inactive") recorder.stop();
      },
      cancel: () => {
        cancelled = true;
        if (recorder.state !== "inactive") recorder.stop();
      },
    });

    recorder.start();
  });
}
