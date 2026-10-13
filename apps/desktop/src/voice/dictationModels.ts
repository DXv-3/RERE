/** Whisper models CodeWrench can dictate with, best first, and where to look for them. */

const FAMILIES = [
  { id: "large-v3-turbo", label: "Large v3 Turbo" },
  { id: "large-v3", label: "Large v3" },
  { id: "medium", label: "Medium" },
  { id: "small", label: "Small" },
  { id: "base", label: "Base" },
  { id: "tiny", label: "Tiny" },
] as const;
// Quantized files are a little less exact than the full model but far smaller.
const QUANTIZATIONS = ["", "-q8_0", "-q5_1", "-q5_0"] as const;
const MODEL_FILE = /^ggml-(large-v3-turbo|large-v3|medium|small|base|tiny)(\.en)?(-q\d_\d)?\.bin$/;

export interface WhisperModel {
  readonly file: string;
  /** What the status line shows, for example "Whisper Large v3 Turbo". */
  readonly label: string;
  /** Lower is better. Only meaningful for comparing models from this module. */
  readonly rank: number;
  /** English-only models cannot detect a language. */
  readonly english: boolean;
  /** Small models are worth upgrading from; medium and above are not. */
  readonly worthUpgrading: boolean;
}

export const ACCURATE_MODEL = {
  file: "ggml-large-v3-turbo-q5_0.bin",
  label: "Whisper Large v3 Turbo",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  bytes: 574_041_195,
  // The Hugging Face LFS object id of the file, which is its SHA-256.
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
} as const;

/** Describes a model file by name, or null when it is not a Whisper model this app can use. */
export function describeModelFile(file: string): WhisperModel | null {
  const match = MODEL_FILE.exec(file);
  if (!match) return null;
  const familyIndex = FAMILIES.findIndex((family) => family.id === match[1]);
  const family = FAMILIES[familyIndex]!;
  const english = match[2] !== undefined;
  const quantization = match[3] ?? "";
  const quantizationIndex = QUANTIZATIONS.indexOf(quantization as (typeof QUANTIZATIONS)[number]);
  return {
    file,
    label: `Whisper ${family.label}${english ? " English" : ""}`,
    // Size family first, then the English-only build (it is the better English model), then precision.
    english,
    rank:
      familyIndex * 100 + (english ? 0 : 10) + (quantizationIndex === -1 ? 9 : quantizationIndex),
    worthUpgrading: familyIndex >= 3,
  };
}

export function pickBestModel<T extends { readonly file: string }>(
  candidates: readonly T[],
): (T & { readonly model: WhisperModel }) | null {
  let best: (T & { readonly model: WhisperModel }) | null = null;
  for (const candidate of candidates) {
    const model = describeModelFile(candidate.file);
    if (model && (!best || model.rank < best.model.rank)) best = { ...candidate, model };
  }
  return best;
}

/**
 * Directories searched for models, in the order they are listed. The first is where
 * the app downloads to, so a model it fetched wins a tie over the same file elsewhere.
 */
export function modelDirectories(input: {
  readonly home: string;
  readonly userDataDirectory?: string | undefined;
  readonly join: (...parts: string[]) => string;
}): string[] {
  const { home, userDataDirectory, join } = input;
  return [
    ...(userDataDirectory ? [join(userDataDirectory, "whisper")] : []),
    join(home, "Library/Application Support/CodeWrench/whisper"),
    join(home, ".local/share/whisper"),
    join(home, ".local/share/whisper-models"),
    "/opt/homebrew/share/whisper-cpp",
    "/usr/local/share/whisper-cpp",
  ];
}
