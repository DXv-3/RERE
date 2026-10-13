/** Loudness (0 to 1) above which a moment of microphone input counts as speech. */
const SPEECH_LEVEL = 0.02;
/** How long a pause after speech ends a recording that stops by itself. */
const SILENCE_AFTER_SPEECH_MS = 2000;

/**
 * Decides when someone has finished talking. Feed it the microphone level a few times a
 * second; it answers true once speech has been heard and then nothing for the pause time.
 * Silence before the first word never ends a recording.
 */
export function createSilenceDetector(
  pauseMs: number = SILENCE_AFTER_SPEECH_MS,
  speechLevel: number = SPEECH_LEVEL,
) {
  let lastSpeechAt: number | null = null;
  return (level: number, nowMs: number): boolean => {
    if (level >= speechLevel) {
      lastSpeechAt = nowMs;
      return false;
    }
    return lastSpeechAt !== null && nowMs - lastSpeechAt >= pauseMs;
  };
}

/** Root-mean-square loudness of one buffer of audio samples. */
export function audioLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
