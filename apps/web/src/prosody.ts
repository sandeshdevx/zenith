/**
 * Client-side acoustic feature extraction (patent modules 301–302).
 * Runs alongside speech recognition on the same microphone stream and
 * produces only numeric features — raw audio never leaves the device.
 *
 * Features: fundamental frequency mean/std (autocorrelation over voiced
 * frames), speech rate (energy onsets/sec), pause ratio, mean RMS energy.
 */
import type { ProsodyFeaturesDto } from "@zenith/contracts";

const FRAME_SIZE = 2048;
const FRAME_INTERVAL_MS = 64;
const SILENCE_RMS = 0.012;
const F0_MIN = 60;
const F0_MAX = 400;

export interface ProsodyCapture {
  /** Stops capture and returns aggregated features (null if too little voice). */
  stop: () => ProsodyFeaturesDto | null;
}

export async function startProsodyCapture(): Promise<ProsodyCapture | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null; // mic denied — recognition layer handles the silent fallback
  }

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = FRAME_SIZE;
  source.connect(analyser);

  const buffer = new Float32Array(FRAME_SIZE);
  const sampleRate = audioContext.sampleRate;

  let totalFrames = 0;
  let silentFrames = 0;
  let onsets = 0;
  let previousSilent = true;
  const pitches: number[] = [];
  const energies: number[] = [];
  const startedAt = performance.now();

  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    totalFrames++;

    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buffer.length);
    const silent = rms < SILENCE_RMS;

    if (silent) {
      silentFrames++;
    } else {
      energies.push(rms);
      if (previousSilent) onsets++; // silence→speech transition ≈ syllabic onset group
      const f0 = estimatePitch(buffer, sampleRate);
      if (f0 !== null) pitches.push(f0);
    }
    previousSilent = silent;
  }, FRAME_INTERVAL_MS);

  return {
    stop: () => {
      window.clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close();

      const durationSec = (performance.now() - startedAt) / 1000;
      const voicedFrames = totalFrames - silentFrames;
      if (durationSec < 1 || voicedFrames < 5) return null; // not enough signal

      const f0Mean = mean(pitches);
      return {
        f0Mean: round2(f0Mean || 0),
        f0Std: round2(std(pitches, f0Mean)),
        speechRate: round2(onsets / durationSec),
        pauseRatio: round2(totalFrames ? silentFrames / totalFrames : 0),
        rmsEnergy: round2(mean(energies)),
      };
    },
  };
}

/** Autocorrelation pitch estimate over one frame; null when unvoiced. */
function estimatePitch(frame: Float32Array, sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / F0_MAX);
  const maxLag = Math.floor(sampleRate / F0_MIN);
  let bestLag = -1;
  let bestCorr = 0;
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += (frame[i] ?? 0) ** 2;
  if (energy < 1e-4) return null;

  for (let lag = minLag; lag <= maxLag && lag < frame.length; lag++) {
    let corr = 0;
    for (let i = 0; i < frame.length - lag; i++) {
      corr += (frame[i] ?? 0) * (frame[i + lag] ?? 0);
    }
    corr /= energy;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestCorr < 0.4) return null; // unvoiced / noise
  return sampleRate / bestLag;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
