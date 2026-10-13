export type DictationEngineSetting = "auto" | "apple" | "whisper";
export type DictationEngine = "apple" | "whisper";

/** Apple's engine runs only when it is available and the user did not insist on whisper. */
export const resolveDictationEngine = (
  setting: DictationEngineSetting,
  appleAvailable: boolean,
): DictationEngine => (setting !== "whisper" && appleAvailable ? "apple" : "whisper");
