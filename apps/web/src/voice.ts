/**
 * Voice mode (PRD Flow A + P0 voice features), zero-cost default:
 * - input: browser SpeechRecognition (WebSpeech API)
 * - output: browser speechSynthesis
 * Both are free, on-device where the browser supports it, and multilingual.
 * A faster-whisper/Piper sidecar can replace these for self-hosters who want
 * consistent quality (services/inference — see README).
 *
 * PRD rule: microphone denied → silent fallback to text. No error surfaces.
 */

type RecognitionCtor = new () => SpeechRecognition;

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export interface ListenSession {
  stop: () => void;
}

/**
 * One listening turn.
 * - onInterim streams everything heard so far into the composer.
 * - onFinal fires when the utterance finished cleanly → auto-send.
 * - onPartial fires when listening ended without a clean final result but
 *   something WAS heard → the text stays in the composer for manual send,
 *   never silently dropped.
 * - onDenied fires on permission problems (silent fallback to text, PRD).
 */
export function listen(
  lang: string,
  handlers: {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onPartial: (text: string) => void;
    onDenied: () => void;
    onEnd: () => void;
  },
): ListenSession | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = true;

  let finalText = "";
  let lastHeard = "";
  let denied = false;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result) continue;
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    lastHeard = `${finalText}${interim}`.trim();
    // Always reflect what has been heard — including finalized-only chunks.
    if (lastHeard) handlers.onInterim(lastHeard);
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      denied = true;
      handlers.onDenied();
    }
    // 'no-speech', 'network', 'aborted' fall through to onend, which
    // preserves anything that was heard instead of dropping it.
  };
  recognition.onend = () => {
    if (!denied) {
      const finished = finalText.trim();
      if (finished) handlers.onFinal(finished);
      else if (lastHeard) handlers.onPartial(lastHeard);
    }
    handlers.onEnd();
  };
  recognition.start();
  return { stop: () => recognition.stop() };
}

// Browser voices load asynchronously — getVoices() is often EMPTY on the
// first call, which silently falls back to the robotic default voice.
// Cache them as they arrive and re-read on voiceschanged.
let cachedVoices: SpeechSynthesisVoice[] = [];
if ("speechSynthesis" in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    cachedVoices = window.speechSynthesis.getVoices();
  });
}

/** Quality ranking: neural/online voices sound human; local SAPI does not. */
function voiceScore(voice: SpeechSynthesisVoice, langPrefix: string): number {
  let score = 0;
  if (voice.lang.toLowerCase().startsWith(langPrefix)) score += 100;
  const name = voice.name.toLowerCase();
  if (name.includes("natural")) score += 50; // Edge neural voices
  if (name.includes("neural")) score += 50;
  if (name.includes("google")) score += 40; // Chrome online voices
  if (name.includes("online")) score += 30;
  if (!voice.localService) score += 20;
  return score;
}

export function bestVoice(lang: string): SpeechSynthesisVoice | null {
  const prefix = (lang.split("-")[0] ?? lang).toLowerCase();
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0;
  for (const voice of cachedVoices) {
    const score = voiceScore(voice, prefix);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return bestScore >= 100 ? best : null; // must at least match the language
}

/** Speak a buddy reply in the user's language; no-op when unsupported. */
export function speak(text: string, lang: string, onEnd?: () => void): void {
  if (!("speechSynthesis" in window)) {
    onEnd?.();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 1.0;
  const match = bestVoice(lang);
  if (match) utterance.voice = match;
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
  }
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
