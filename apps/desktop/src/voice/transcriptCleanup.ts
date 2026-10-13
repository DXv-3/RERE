/**
 * Biases whisper toward the words people say to a coding agent and toward
 * normal punctuation and capitalisation. Passed as `--prompt`.
 */
export const DICTATION_PROMPT =
  "CodeWrench, Claude, Codex, GitHub, pull request, TypeScript, repo, worktree, deploy, thread.";

// Words whisper puts in parentheses or asterisks to describe sound rather than speech.
const SOUND_WORDS =
  /\b(silence|silent|blank|music|musical|applause|laughter|laughs?|laughing|noise|noises|inaudible|unintelligible|sighs?|coughs?|coughing|static|background|wind|typing|clicking|beeps?|speaking|foreign|crosstalk|singing|whistling|breathing|audio|sound|sounds|pause|buzzing|ringing|chatter|door)\b/i;
// Whole transcripts whisper invents from silence or a bumped microphone.
const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "thank you for watching",
  "thanks for watching",
  "subtitles by the amara.org community",
]);

/**
 * Turns whisper's text output into plain sentences: drops non-speech tags such as
 * `[BLANK_AUDIO]` or `(silence)`, speaker-change `>>` markers and a repeated prompt,
 * and joins the per-segment lines. Returns an empty string when no speech remains.
 */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]\n]{0,60}\]/g, " ")
    .replace(/\(([^)\n]{1,40})\)/g, (tag, inner: string) => (SOUND_WORDS.test(inner) ? " " : tag))
    .replace(/\*([^*\n]{1,40})\*/g, (tag, inner: string) => (SOUND_WORDS.test(inner) ? " " : tag))
    .replace(/[♪♫]+/g, " ")
    .replaceAll(DICTATION_PROMPT, " ")
    .replace(/(^|\s)>>+(?=\s|$)/g, " ")
    .replace(/(^|\n)\s*-\s+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  const letters = text.toLowerCase().replace(/[^a-z .]/g, "");
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return SILENCE_HALLUCINATIONS.has(letters.replace(/[.\s]+$/, "")) ? "" : text;
}
