import { CAMPAIGN_MODEL_CAPABILITIES } from "@t3tools/shared/campaignModelCapabilities";
import type {
  CampaignClient,
  CampaignGenerationBoard,
  CampaignGeneratorKind,
  CampaignGeneratorService,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  LOCAL_GPU_DEFAULT_VIDEO_PRESET,
  LOCAL_GPU_PRESETS,
  LOCAL_GPU_VIDEO_PRESETS,
} from "@t3tools/shared/campaignRules";
import { useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { useId, useState, type FormEvent } from "react";

import { CampaignGenerationList } from "../campaigns/CampaignGenerationList";
import { GENERATOR_LABEL } from "../campaigns/generation.logic";
import { useCampaignCommand, useIsCampaignAdministrator } from "../campaigns/useCampaigns";
import { useWorkbenchStore } from "../workbench/workbenchStore";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";

const IMAGE_CHOICES: ReadonlyArray<CampaignGeneratorKind> = [
  "none",
  "openrouter",
  "muapi",
  "fal",
  "local",
  "local-gpu",
];
/** The model Select's value for "a folder the person points at". */
const GPU_FOLDER = "folder";
const GPU_WHEN_BUSY_CHOICES = [
  { value: "fallback", label: "Use A Smaller Model" },
  { value: "wait", label: "Wait Until There Is Room" },
] as const;
const VIDEO_CHOICES: ReadonlyArray<CampaignGeneratorKind> = [
  "none",
  "openrouter",
  "muapi",
  "fal",
  "marketing-engine",
  "local-gpu",
];
function GeneratorSelect({
  label,
  value,
  choices,
  onChange,
}: {
  readonly label: string;
  readonly value: CampaignGeneratorKind;
  readonly choices: ReadonlyArray<CampaignGeneratorKind>;
  readonly onChange: (next: CampaignGeneratorKind) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as CampaignGeneratorKind)}>
      <SelectTrigger size="sm" className="w-64" aria-label={label}>
        <SelectValue>{GENERATOR_LABEL[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {choices.map((choice) => (
          <SelectItem hideIndicator key={choice} value={choice}>
            {GENERATOR_LABEL[choice]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Which service makes campaign images and video, how to reach it, and the jobs it has made.
 * Both choices start as None, which makes nothing and spends nothing. Starting, approving and
 * changing these are administrator actions; the server refuses anyone else. The OpenRouter, MuAPI and fal.ai
 * keys are write-only.
 */
export function CampaignGenerationSettings({
  environmentId,
  generation,
  clients,
}: {
  readonly environmentId: EnvironmentId;
  readonly generation: CampaignGenerationBoard;
  readonly clients: ReadonlyArray<Pick<CampaignClient, "id" | "name">>;
}) {
  const { settings } = generation;
  const ids = {
    key: useId(),
    muapiKey: useId(),
    falKey: useId(),
    imageModel: useId(),
    videoModel: useId(),
    local: useId(),
    localModel: useId(),
    gpuPython: useId(),
    gpuFolder: useId(),
    gpuModelsDir: useId(),
    gpuWindowStart: useId(),
    gpuWindowEnd: useId(),
  };
  const run = useCampaignCommand(environmentId);
  const [imageGenerator, setImageGenerator] = useState(settings.imageGenerator);
  const [videoGenerator, setVideoGenerator] = useState(settings.videoGenerator);
  const [imageModel, setImageModel] = useState(settings.models.image);
  const [videoModel, setVideoModel] = useState(settings.models.video);
  const [localBaseUrl, setLocalBaseUrl] = useState(settings.localBaseUrl);
  const [localModel, setLocalModel] = useState(settings.models.local);
  const [gpuPython, setGpuPython] = useState(settings.localGpu.python);
  const [gpuModel, setGpuModel] = useState(settings.localGpu.model);
  const [gpuVideoModel, setGpuVideoModel] = useState(settings.localGpu.videoModel);
  const [gpuFolderMode, setGpuFolderMode] = useState(
    settings.localGpu.model !== "" &&
      !LOCAL_GPU_PRESETS.some((preset) => preset.id === settings.localGpu.model),
  );
  const [gpuModelsDir, setGpuModelsDir] = useState(settings.localGpu.modelsDir);
  const [gpuWhenBusy, setGpuWhenBusy] = useState(settings.localGpu.whenBusy);
  const [gpuWindowStart, setGpuWindowStart] = useState(settings.localGpu.windowStart);
  const [gpuWindowEnd, setGpuWindowEnd] = useState(settings.localGpu.windowEnd);
  const [key, setKey] = useState("");
  const [muapiKey, setMuapiKey] = useState("");
  const [falKey, setFalKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<
    CampaignGeneratorService | "download" | "gpu-video" | "download-video" | null
  >(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
    notes?: string | undefined;
  } | null>(null);

  const dirty =
    imageGenerator !== settings.imageGenerator ||
    videoGenerator !== settings.videoGenerator ||
    imageModel.trim() !== settings.models.image ||
    videoModel.trim() !== settings.models.video ||
    localBaseUrl.trim() !== settings.localBaseUrl ||
    localModel.trim() !== settings.models.local ||
    gpuPython.trim() !== settings.localGpu.python ||
    gpuModel.trim() !== settings.localGpu.model ||
    gpuVideoModel.trim() !== settings.localGpu.videoModel ||
    gpuModelsDir.trim() !== settings.localGpu.modelsDir ||
    gpuWhenBusy !== settings.localGpu.whenBusy ||
    gpuWindowStart !== settings.localGpu.windowStart ||
    gpuWindowEnd !== settings.localGpu.windowEnd ||
    key !== "" ||
    muapiKey !== "" ||
    falKey !== "";
  const usesOpenRouter = imageGenerator === "openrouter" || videoGenerator === "openrouter";
  const usesMuapi = imageGenerator === "muapi" || videoGenerator === "muapi";
  const usesFal = imageGenerator === "fal" || videoGenerator === "fal";
  const usesLocal = imageGenerator === "local";
  const usesGpu = imageGenerator === "local-gpu";
  const usesGpuVideo = videoGenerator === "local-gpu";
  const videoPreset =
    LOCAL_GPU_VIDEO_PRESETS.find(
      (candidate) => candidate.id === (gpuVideoModel || LOCAL_GPU_DEFAULT_VIDEO_PRESET),
    ) ?? LOCAL_GPU_VIDEO_PRESETS[0];

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setTestResult(null);
    const outcome = await run({
      command: "generation.settings.set",
      settings: {
        imageGenerator,
        videoGenerator,
        imageModel,
        videoModel,
        localBaseUrl,
        localModel,
        localGpuPython: gpuPython,
        localGpuModel: gpuModel,
        localGpuVideoModel: gpuVideoModel,
        localGpuModelsDir: gpuModelsDir,
        localGpuWhenBusy: gpuWhenBusy,
        localGpuWindowStart: gpuWindowStart,
        localGpuWindowEnd: gpuWindowEnd,
        ...(key === "" ? {} : { openRouterKey: Redacted.make(key.trim()) }),
        ...(muapiKey === "" ? {} : { muapiKey: Redacted.make(muapiKey.trim()) }),
        ...(falKey === "" ? {} : { falKey: Redacted.make(falKey.trim()) }),
      },
    });
    setSaving(false);
    if (!outcome.ok) {
      setSaveError(outcome.message);
      return;
    }
    // The key is on the server now; do not leave it sitting in the page.
    setKey("");
    setMuapiKey("");
    setFalKey("");
    setSaved(true);
  };

  const removeKey = async (which: "openRouterKey" | "muapiKey" | "falKey") => {
    setSaving(true);
    setSaveError(null);
    const outcome = await run({
      command: "generation.settings.set",
      settings: { [which]: null },
    });
    setSaving(false);
    if (!outcome.ok) setSaveError(outcome.message);
  };

  const test = async (generator: CampaignGeneratorService, action?: "download", kind?: "video") => {
    setTesting(
      kind === "video"
        ? action === "download"
          ? "download-video"
          : "gpu-video"
        : (action ?? generator),
    );
    setTestResult(null);
    const outcome = await run({
      command: "generation.test",
      generator,
      ...(action === undefined ? {} : { action }),
      ...(kind === undefined ? {} : { kind }),
    });
    setTesting(null);
    if (!outcome.ok) {
      setTestResult({ ok: false, text: outcome.message });
      return;
    }
    if (outcome.value.kind !== "connectionTest") return;
    const { result } = outcome.value;
    const done =
      action === "download"
        ? "The model is downloaded."
        : generator === "local-gpu"
          ? kind === "video"
            ? "This computer can make video."
            : "This computer can make images."
          : `${GENERATOR_LABEL[generator]} works.`;
    setTestResult(
      result.ok
        ? { ok: true, text: done, notes: result.notes }
        : { ok: false, text: result.reason ?? "It did not work.", notes: result.notes },
    );
  };

  const testable = (
    [
      ["openrouter", usesOpenRouter],
      ["muapi", usesMuapi],
      ["fal", usesFal],
      ["marketing-engine", videoGenerator === "marketing-engine"],
      ["local", usesLocal],
      ["local-gpu", usesGpu],
    ] as const
  ).filter(([, used]) => used);

  return (
    <>
      <SettingsRow
        title="Images And Video"
        description="Which service makes pictures and video for campaigns. None makes nothing and spends nothing. A chat subscription alone cannot make video."
      >
        <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => void save(event)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium">Images</span>
            <GeneratorSelect
              label="Image generator"
              value={imageGenerator}
              choices={IMAGE_CHOICES}
              onChange={setImageGenerator}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium">Video</span>
            <GeneratorSelect
              label="Video generator"
              value={videoGenerator}
              choices={VIDEO_CHOICES}
              onChange={setVideoGenerator}
            />
          </div>
          {usesOpenRouter ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.key}>
                  OpenRouter Key
                </label>
                <Input
                  id={ids.key}
                  nativeInput
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={
                    settings.hasOpenRouterKey
                      ? "Type a new key to replace the saved one"
                      : "Paste your OpenRouter key"
                  }
                  value={key}
                  onChange={(event) => setKey(event.currentTarget.value)}
                />
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {settings.hasOpenRouterKey ? "A key is saved." : "No key is saved."}
                  {settings.hasOpenRouterKey ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost-muted"
                      disabled={saving}
                      onClick={() => void removeKey("openRouterKey")}
                    >
                      Remove Saved Key
                    </Button>
                  ) : null}
                </p>
              </div>
              {imageGenerator === "openrouter" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={ids.imageModel}>
                    Image Model
                  </label>
                  <Input
                    id={ids.imageModel}
                    nativeInput
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Empty uses google/gemini-2.5-flash-image"
                    value={imageModel}
                    onChange={(event) => setImageModel(event.currentTarget.value)}
                  />
                </div>
              ) : null}
              {videoGenerator === "openrouter" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={ids.videoModel}>
                    Video Model
                  </label>
                  <Input
                    id={ids.videoModel}
                    nativeInput
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Empty uses bytedance/seedance-2.0-fast"
                    value={videoModel}
                    onChange={(event) => setVideoModel(event.currentTarget.value)}
                  />
                </div>
              ) : null}
            </>
          ) : null}
          {usesMuapi ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.muapiKey}>
                  MuAPI Key
                </label>
                <Input
                  id={ids.muapiKey}
                  nativeInput
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={
                    settings.hasMuapiKey
                      ? "Type a new key to replace the saved one"
                      : "Paste your MuAPI key"
                  }
                  value={muapiKey}
                  onChange={(event) => setMuapiKey(event.currentTarget.value)}
                />
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {settings.hasMuapiKey ? "A key is saved." : "No key is saved."}
                  {settings.hasMuapiKey ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost-muted"
                      disabled={saving}
                      onClick={() => void removeKey("muapiKey")}
                    >
                      Remove Saved Key
                    </Button>
                  ) : null}
                </p>
              </div>
              {imageGenerator === "muapi" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={`${ids.imageModel}-muapi`}>
                    Image Model
                  </label>
                  <datalist id={`${ids.imageModel}-muapi-choices`}>
                    {CAMPAIGN_MODEL_CAPABILITIES.filter(
                      (entry) => entry.connector === "muapi" && entry.kind === "image",
                    ).map((entry) => (
                      <option key={entry.model} value={entry.model}>
                        {entry.label}
                      </option>
                    ))}
                  </datalist>
                  <Input
                    id={`${ids.imageModel}-muapi`}
                    list={`${ids.imageModel}-muapi-choices`}
                    nativeInput
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Empty uses flux-dev"
                    value={imageModel}
                    onChange={(event) => setImageModel(event.currentTarget.value)}
                  />
                </div>
              ) : null}
              {videoGenerator === "muapi" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={`${ids.videoModel}-muapi`}>
                    Video Model
                  </label>
                  <datalist id={`${ids.videoModel}-muapi-choices`}>
                    {CAMPAIGN_MODEL_CAPABILITIES.filter(
                      (entry) => entry.connector === "muapi" && entry.kind === "video",
                    ).map((entry) => (
                      <option key={entry.model} value={entry.model}>
                        {entry.label}
                      </option>
                    ))}
                  </datalist>
                  <Input
                    id={`${ids.videoModel}-muapi`}
                    list={`${ids.videoModel}-muapi-choices`}
                    nativeInput
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Empty uses veo3.1-image-to-video"
                    value={videoModel}
                    onChange={(event) => setVideoModel(event.currentTarget.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    For video from a still image, use an image-to-video model such as
                    veo3.1-image-to-video or runway-image-to-video.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
          {usesFal ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.falKey}>
                  fal.ai Key
                </label>
                <Input
                  id={ids.falKey}
                  nativeInput
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={
                    settings.hasFalKey
                      ? "Type a new key to replace the saved one"
                      : "Paste your fal.ai key"
                  }
                  value={falKey}
                  onChange={(event) => setMuapiKey(event.currentTarget.value)}
                />
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {settings.hasFalKey ? "A key is saved." : "No key is saved."}
                  {settings.hasFalKey ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost-muted"
                      disabled={saving}
                      onClick={() => void removeKey("falKey")}
                    >
                      Remove Saved Key
                    </Button>
                  ) : null}
                </p>
              </div>
              {imageGenerator === "fal" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={`${ids.imageModel}-fal`}>
                    Image Model
                  </label>
                  <datalist id={`${ids.imageModel}-fal-choices`}>
                    {CAMPAIGN_MODEL_CAPABILITIES.filter(
                      (entry) => entry.connector === "fal" && entry.kind === "image",
                    ).map((entry) => (
                      <option key={entry.model} value={entry.model}>
                        {entry.label}
                      </option>
                    ))}
                  </datalist>
                  <Input
                    id={`${ids.imageModel}-fal`}
                    list={`${ids.imageModel}-fal-choices`}
                    nativeInput
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Empty uses fal-ai/flux/dev"
                    value={imageModel}
                    onChange={(event) => setImageModel(event.currentTarget.value)}
                  />
                </div>
              ) : null}
              {videoGenerator === "fal" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={`${ids.videoModel}-fal`}>
                    Video Model
                  </label>
                  <datalist id={`${ids.videoModel}-fal-choices`}>
                    {CAMPAIGN_MODEL_CAPABILITIES.filter(
                      (entry) => entry.connector === "fal" && entry.kind === "video",
                    ).map((entry) => (
                      <option key={entry.model} value={entry.model}>
                        {entry.label}
                      </option>
                    ))}
                  </datalist>
                  <Input
                    id={`${ids.videoModel}-fal`}
                    list={`${ids.videoModel}-fal-choices`}
                    nativeInput
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Empty uses fal-ai/veo3.1/image-to-video"
                    value={videoModel}
                    onChange={(event) => setVideoModel(event.currentTarget.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    For video from a still image, use an image-to-video model such as
                    fal-ai/veo3.1/image-to-video or fal-ai/kling-video/v3/pro/image-to-video.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
          {usesLocal ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.local}>
                  Local Server Address
                </label>
                <Input
                  id={ids.local}
                  nativeInput
                  inputMode="url"
                  placeholder="http://localhost:8080"
                  autoComplete="off"
                  spellCheck={false}
                  value={localBaseUrl}
                  onChange={(event) => setLocalBaseUrl(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.localModel}>
                  Local Model
                </label>
                <Input
                  id={ids.localModel}
                  nativeInput
                  font="mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={localModel}
                  onChange={(event) => setLocalModel(event.currentTarget.value)}
                />
              </div>
            </>
          ) : null}
          {usesGpu || usesGpuVideo ? (
            <>
              <p className="text-xs text-muted-foreground">
                Free. Slower and lower quality than hosted models. Needs a graphics card with enough
                free memory.
              </p>
              {usesGpuVideo ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Video Model</span>
                  <Select
                    value={gpuVideoModel || LOCAL_GPU_DEFAULT_VIDEO_PRESET}
                    onValueChange={(next) => {
                      if (next !== null) setGpuVideoModel(next);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Video model for this computer's GPU">
                      <SelectValue>{videoPreset.label}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {LOCAL_GPU_VIDEO_PRESETS.map((preset) => (
                        <SelectItem hideIndicator key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    License: {videoPreset.license}. The first use downloads about{" "}
                    {videoPreset.downloadGb} GB. It makes {videoPreset.minSeconds} to{" "}
                    {videoPreset.maxSeconds} second videos from a still image, which you choose when
                    you generate. Each takes a few minutes, so it runs best overnight.
                  </p>
                </div>
              ) : null}
              {usesGpu ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Model</span>
                  <Select
                    value={gpuFolderMode ? GPU_FOLDER : gpuModel || LOCAL_GPU_PRESETS[0].id}
                    onValueChange={(next) => {
                      if (next === null) return;
                      if (next === GPU_FOLDER) {
                        setGpuFolderMode(true);
                        setGpuModel("");
                        return;
                      }
                      setGpuFolderMode(false);
                      setGpuModel(next);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Model for this computer's GPU">
                      <SelectValue>
                        {gpuFolderMode
                          ? "A Folder On This Computer"
                          : (LOCAL_GPU_PRESETS.find(
                              (preset) => preset.id === (gpuModel || LOCAL_GPU_PRESETS[0].id),
                            )?.label ?? gpuModel)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {LOCAL_GPU_PRESETS.map((preset) => (
                        <SelectItem hideIndicator key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                      <SelectItem hideIndicator value={GPU_FOLDER}>
                        A Folder On This Computer
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                  {gpuFolderMode ? (
                    <Input
                      id={ids.gpuFolder}
                      nativeInput
                      font="mono"
                      aria-label="Model folder"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="/home/you/models/my-diffusers-model"
                      value={gpuModel}
                      onChange={(event) => setGpuModel(event.currentTarget.value)}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {(() => {
                        const preset =
                          LOCAL_GPU_PRESETS.find(
                            (candidate) => candidate.id === (gpuModel || LOCAL_GPU_PRESETS[0].id),
                          ) ?? LOCAL_GPU_PRESETS[0];
                        return `License: ${preset.license}. The first use downloads about ${preset.downloadGb} GB.`;
                      })()}
                    </p>
                  )}
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.gpuPython}>
                  Python
                </label>
                <Input
                  id={ids.gpuPython}
                  nativeInput
                  font="mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Empty finds one with PyTorch and diffusers"
                  value={gpuPython}
                  onChange={(event) => setGpuPython(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.gpuModelsDir}>
                  Models Folder
                </label>
                <Input
                  id={ids.gpuModelsDir}
                  nativeInput
                  font="mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Empty uses ~/.codewrench/localgen/models"
                  value={gpuModelsDir}
                  onChange={(event) => setGpuModelsDir(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">When The Graphics Card Is Busy</span>
                <Select
                  value={gpuWhenBusy}
                  onValueChange={(next) => {
                    if (next === "fallback" || next === "wait") setGpuWhenBusy(next);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="When the graphics card is busy">
                    <SelectValue>
                      {GPU_WHEN_BUSY_CHOICES.find((choice) => choice.value === gpuWhenBusy)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {GPU_WHEN_BUSY_CHOICES.map((choice) => (
                      <SelectItem hideIndicator key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Text models share the card. When the model you chose does not fit, a smaller one
                  makes the image now, or the image waits and is tried again every few minutes for
                  up to a day. A video has no smaller model, so it always waits.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={ids.gpuWindowStart}>
                    Only Start After
                  </label>
                  <Input
                    id={ids.gpuWindowStart}
                    nativeInput
                    type="time"
                    className="w-36"
                    value={gpuWindowStart}
                    onChange={(event) => setGpuWindowStart(event.currentTarget.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium" htmlFor={ids.gpuWindowEnd}>
                    Stop Starting At
                  </label>
                  <Input
                    id={ids.gpuWindowEnd}
                    nativeInput
                    type="time"
                    className="w-36"
                    value={gpuWindowEnd}
                    onChange={(event) => setGpuWindowEnd(event.currentTarget.value)}
                  />
                </div>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">
                Optional quiet hours on this computer's clock, like 22:00 to 06:00. Images and video
                only start inside them and otherwise wait. Leave both empty to start any time.
              </p>
            </>
          ) : null}
          {videoGenerator === "marketing-engine" ? (
            <p className="text-xs text-muted-foreground">
              The marketing engine uses the address and key from Campaign Publishing, and each
              client needs its publishing id.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" type="submit" disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" /> : null}
              Save Changes
            </Button>
            {testable.map(([generator]) => (
              <Button
                key={generator}
                size="sm"
                type="button"
                variant="outline"
                disabled={testing !== null || saving || dirty}
                onClick={() => void test(generator)}
              >
                {testing === generator ? <Spinner size="sm" /> : null}
                Test {GENERATOR_LABEL[generator]}
              </Button>
            ))}
            {usesGpuVideo ? (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={testing !== null || saving || dirty}
                onClick={() => void test("local-gpu", undefined, "video")}
              >
                {testing === "gpu-video" ? <Spinner size="sm" /> : null}
                Test GPU Video
              </Button>
            ) : null}
            {usesGpu && !gpuFolderMode ? (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={testing !== null || saving || dirty}
                onClick={() => void test("local-gpu", "download")}
              >
                {testing === "download" ? <Spinner size="sm" /> : null}
                Download Model
              </Button>
            ) : null}
            {usesGpuVideo ? (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={testing !== null || saving || dirty}
                onClick={() => void test("local-gpu", "download", "video")}
              >
                {testing === "download-video" ? <Spinner size="sm" /> : null}
                Download Video Model
              </Button>
            ) : null}
            {testing === "download" || testing === "download-video" ? (
              <span role="status" className="text-xs text-muted-foreground">
                Downloading. This can take several minutes.
              </span>
            ) : dirty ? (
              <span className="text-xs text-muted-foreground">Save before testing.</span>
            ) : saved ? (
              <span role="status" className="text-xs text-muted-foreground">
                Saved.
              </span>
            ) : null}
          </div>
          {saveError ? (
            <Alert variant="error">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}
          {testResult ? (
            <Alert variant={testResult.ok ? "success" : "error"}>
              <AlertDescription>
                {testResult.ok ? "Connected. " : "Not connected. "}
                {testResult.text}
                {testResult.notes ? (
                  <span className="mt-1 block whitespace-pre-line">{testResult.notes}</span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
      </SettingsRow>
      <RecentGenerations environmentId={environmentId} generation={generation} clients={clients} />
    </>
  );
}

function RecentGenerations({
  environmentId,
  generation,
  clients,
}: {
  readonly environmentId: EnvironmentId;
  readonly generation: CampaignGenerationBoard;
  readonly clients: ReadonlyArray<Pick<CampaignClient, "id" | "name">>;
}) {
  const run = useCampaignCommand(environmentId);
  const isAdministrator = useIsCampaignAdministrator(environmentId);
  const navigate = useNavigate();
  const setMode = useWorkbenchStore((state) => state.setMode);
  const setAgentView = useWorkbenchStore((state) => state.setAgentView);
  const { jobs } = generation;
  const openBoard = () => {
    setAgentView("campaigns");
    setMode("agent");
    void navigate({ to: "/" });
  };
  return (
    <SettingsRow
      title="Recent Generations"
      description="Pictures and video made for campaigns. A job an agent asked for under Ask Me First waits here until you approve it. Nothing is spent before then. To make one, or to use a finished file in a post, open the campaign."
      control={
        <Button size="sm" variant="outline" onClick={openBoard}>
          Open Campaigns
        </Button>
      }
    >
      {jobs.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Nothing has been made yet.</p>
      ) : (
        <div className="mt-3">
          <CampaignGenerationList
            environmentId={environmentId}
            jobs={jobs}
            isAdministrator={isAdministrator}
            run={run}
            clientNameOf={(clientId) => clients.find((client) => client.id === clientId)?.name}
          />
        </div>
      )}
    </SettingsRow>
  );
}
