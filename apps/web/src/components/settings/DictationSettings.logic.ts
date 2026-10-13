import type { DesktopDictationStatus, DictationEngineSetting } from "@t3tools/contracts";

export const DICTATION_ENGINE_LABELS: Record<DictationEngineSetting, string> = {
  auto: "Automatic",
  apple: "Apple on-device speech",
  whisper: "Whisper",
};

/** Plain words for the engine row: what is in use now, and why it may differ from the choice. */
export function dictationEngineDescription(
  choice: DictationEngineSetting,
  status: DesktopDictationStatus | null,
): string {
  if (status === null) return "Checking the voice tools on this computer.";
  // Builds that predate the Apple engine always use Whisper and report no engine.
  if (status.engine === undefined) return "Dictation runs on this computer with Whisper.";
  if (status.engine === "apple") {
    return "Dictation uses the speech recognition built into your Mac. Words appear as you speak, nothing needs installing, and your voice never leaves this computer.";
  }
  const whisper =
    "Dictation uses Whisper, which needs a one-time install and a downloaded model, and shows words about once a second.";
  if (choice === "whisper") return whisper;
  return `Apple's on-device speech is not available here (it needs a Mac, an updated app, and a language your Mac can recognize offline), so ${whisper.charAt(0).toLowerCase()}${whisper.slice(1)}`;
}
