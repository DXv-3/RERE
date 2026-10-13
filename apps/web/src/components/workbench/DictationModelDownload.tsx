import { Download, X } from "lucide-react";
import {
  cancelDictationModelDownload,
  downloadDictationModel,
  useDictationModel,
} from "./useDictationModel";

export const modelSizeLabel = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Percent done for a progress readout, or null while the total is not known yet. */
export const downloadPercent = (progress: { bytesDone: number; bytesTotal: number } | null) =>
  progress && progress.bytesTotal > 0
    ? Math.min(100, Math.floor((progress.bytesDone / progress.bytesTotal) * 100))
    : null;

/**
 * Offers the accurate Whisper model when dictation runs on a small one, with progress and a way
 * to stop while it downloads. Shows nothing when there is nothing to offer.
 */
export function DictationModelDownload({ variant }: { variant: "icon" | "text" }) {
  const { status, progress, downloading, error, canDownload } = useDictationModel();
  const label = `Get the accurate voice model · ${modelSizeLabel(status?.modelDownloadBytes ?? 0)}`;
  const percent = downloadPercent(progress);
  return (
    <>
      {downloading ? (
        <>
          <small role="status" aria-live="polite">
            Downloading voice model{percent === null ? "…" : ` · ${percent}%`}
          </small>
          <button
            type="button"
            aria-label="Cancel voice model download"
            onClick={() => void cancelDictationModelDownload()}
          >
            <X size={14} />
          </button>
        </>
      ) : canDownload ? (
        <button type="button" onClick={() => void downloadDictationModel()} aria-label={label}>
          <Download size={14} />
          {variant === "text" ? label : null}
        </button>
      ) : null}
      {error && <span role="alert">{error}</span>}
    </>
  );
}
