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
 * One listening turn. onFinal fires with the finished utterance;
 * onDenied fires on permission problems (caller falls back to text,
 * silently). onInterim streams the in-progress transcript.
 */
export function listen(
  lang: string,
  handlers: {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
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
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result) continue;
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (interim) handlers.onInterim(finalText + interim);
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      handlers.onDenied();
    }
  };
  recognition.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd();
  };
  recognition.start();
  return { stop: () => recognition.stop() };
}

/** Speak a buddy reply in the user's language; no-op when unsupported. */
export function speak(text: string, lang: string): void {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.95; // slightly slower — calm, unhurried
  const voices = window.speechSynthesis.getVoices();
  const match =
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.startsWith(lang.split("-")[0] ?? lang));
  if (match) utterance.voice = match;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
