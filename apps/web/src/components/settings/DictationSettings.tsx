import {
  cancelDictationModelDownload,
  downloadDictationModel,
  useDictationModel,
} from "../workbench/useDictationModel";
import { downloadPercent, modelSizeLabel } from "../workbench/DictationModelDownload";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DICTATION_ENGINE_LABELS, dictationEngineDescription } from "./DictationSettings.logic";
import { refreshDictationStatus } from "../workbench/useDictationModel";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { VoiceKeySettings } from "./VoiceKeySettings";

/**
 * Which engine voice dictation uses and, for Whisper, which model and a way to get the accurate
 * one. Apple's engine has no model to download. Desktop app only.
 */
export function DictationSettings() {
  const { status, progress, downloading, error, canDownload } = useDictationModel();
  const engineChoice = useScopedSettings((settings) => settings.dictationEngine);
  const updateSettings = useUpdateScopedSettings();
  const usesApple = status?.engine === "apple";
  const percent = downloadPercent(progress);
  const size = modelSizeLabel(status?.modelDownloadBytes ?? 0);
  return (
    <>
      <VoiceKeySettings />
      <SettingsRow
        {...searchableSetting("voice-dictation")}
        title="Dictation engine"
        description={dictationEngineDescription(engineChoice, status)}
        control={
          <Select
            value={engineChoice}
            onValueChange={(value) => {
              if (value !== "auto" && value !== "apple" && value !== "whisper") return;
              updateSettings({ dictationEngine: value });
              // The desktop app picks up the new choice a moment after it is saved.
              setTimeout(() => void refreshDictationStatus(), 400);
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Dictation engine">
              <SelectValue>{DICTATION_ENGINE_LABELS[engineChoice]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(DICTATION_ENGINE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {/* Apple's engine has no model to get, so only Whisper (or a failed download) needs this row. */}
      {usesApple && !error ? null : (
        <SettingsRow
          title="Whisper model"
          description={
            error ||
            (status === null
              ? "Checking the voice tools on this computer."
              : !status.available
                ? (status.reason ?? "Voice dictation is not set up on this computer.")
                : canDownload
                  ? `Dictation runs on this computer with ${status.model}. The accurate model recognizes technical words much better. It downloads once and stays on this computer.`
                  : `Dictation runs on this computer with ${status.model}, the most accurate model installed.`)
          }
          control={
            downloading ? (
              <div className="flex items-center gap-2">
                <span role="status" className="text-muted-foreground text-xs">
                  Downloading{percent === null ? "…" : ` · ${percent}%`}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void cancelDictationModelDownload()}
                >
                  Cancel
                </Button>
              </div>
            ) : canDownload ? (
              <Button size="xs" variant="outline" onClick={() => void downloadDictationModel()}>
                Get the accurate voice model · {size}
              </Button>
            ) : null
          }
        />
      )}
    </>
  );
}
