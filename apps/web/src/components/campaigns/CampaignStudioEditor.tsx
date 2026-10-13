import {
  CAMPAIGN_MODEL_CAPABILITIES,
  getCampaignModelCapability,
} from "@t3tools/shared/campaignModelCapabilities";
import { randomUUID } from "../../lib/utils";
import {
  CAMPAIGN_PLATFORMS,
  CAMPAIGN_PLATFORM_LABELS,
  type EnvironmentId,
  type StudioBrief,
  type StudioScene,
  type StudioAsset,
} from "@t3tools/contracts";
import { useId } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { duplicateStudioScene, moveStudioScene, studioSceneVariants } from "./studio.logic";
import { StudioVariantComparison } from "./StudioVariantComparison";
import { StudioStoryboardTemplates } from "./StudioStoryboardTemplates";

export function StudioBriefEditor({
  brief,
  onChange,
}: {
  readonly brief: StudioBrief;
  readonly onChange: (brief: StudioBrief) => void;
}) {
  const id = useId();
  return (
    <section className="space-y-3" aria-label="Creative brief">
      <h3 className="text-sm font-semibold">Creative brief</h3>
      {(["offer", "audience", "objective"] as const).map((field) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`${id}-${field}`}>
            {field === "offer"
              ? "Offer / product"
              : field === "audience"
                ? "Audience"
                : "Objective"}
          </Label>
          <Textarea
            id={`${id}-${field}`}
            value={brief[field]}
            maxLength={field === "offer" ? 4000 : 2000}
            onChange={(event) => onChange({ ...brief, [field]: event.currentTarget.value })}
          />
        </div>
      ))}
      <div className="space-y-1">
        <Label htmlFor={`${id}-duration`}>Target duration (15–60 seconds)</Label>
        <Input
          nativeInput
          id={`${id}-duration`}
          type="number"
          min={15}
          max={60}
          step={1}
          value={brief.durationSeconds}
          onChange={(event) =>
            onChange({ ...brief, durationSeconds: event.currentTarget.valueAsNumber })
          }
        />
      </div>
      <div>
        <Label htmlFor={`${id}-budget`}>Campaign spending budget (USD, optional)</Label>
        <Input
          nativeInput
          id={`${id}-budget`}
          type="number"
          min={0}
          step="0.01"
          value={brief.budgetUsd ?? ""}
          onChange={(event) =>
            onChange({
              ...brief,
              budgetUsd:
                event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber,
            })
          }
        />
        <p className="text-xs text-muted-foreground">Shared by scene generation and narration.</p>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Platforms</legend>
        <div className="flex flex-wrap gap-3">
          {CAMPAIGN_PLATFORMS.map((platform) => (
            <label key={platform} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={brief.platforms.includes(platform)}
                onChange={(event) =>
                  onChange({
                    ...brief,
                    platforms: event.currentTarget.checked
                      ? [...brief.platforms, platform]
                      : brief.platforms.filter((value) => value !== platform),
                  })
                }
              />
              {CAMPAIGN_PLATFORM_LABELS[platform]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor={`${id}-references`}>References (one URL or workspace path per line)</Label>
        <Textarea
          id={`${id}-references`}
          value={brief.references.join("\n")}
          onChange={(event) =>
            onChange({ ...brief, references: event.currentTarget.value.split("\n") })
          }
        />
      </div>
    </section>
  );
}

export function StudioStoryboard({
  environmentId,
  savedBrief,
  brandNotes = "",
  scenes,
  assets,
  onChange,
}: {
  readonly environmentId?: EnvironmentId;
  readonly savedBrief?: StudioBrief;
  readonly brandNotes?: string;
  readonly scenes: readonly StudioScene[];
  readonly assets: readonly StudioAsset[];
  readonly onChange: (scenes: readonly StudioScene[]) => void;
}) {
  const id = useId();
  const update = (sceneId: string, patch: Partial<StudioScene>) =>
    onChange(scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene)));
  return (
    <section aria-label="Storyboard" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Storyboard · {scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)} seconds
        </h3>
        <Button
          size="sm"
          variant="outline"
          disabled={scenes.length >= 30}
          onClick={() =>
            onChange([
              ...scenes,
              {
                id: randomUUID(),
                title: `Scene ${scenes.length + 1}`,
                durationSeconds: 5,
                prompt: "",
                referenceImage: null,
                narration: "",
                onScreenText: "",
                selectedAssetId: null,
                connector: "",
                model: "",
                resolution: "720p",
                generateAudio: false,
                allowanceUsd: null,
              },
            ])
          }
        >
          Add scene
        </Button>
      </div>
      {savedBrief && (
        <StudioStoryboardTemplates
          savedBrief={savedBrief}
          brandNotes={brandNotes}
          scenes={scenes}
          onChange={onChange}
        />
      )}
      {scenes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add a scene or ask the campaign AI to propose a storyboard from your saved brief.
        </p>
      )}
      <ol className="space-y-3">
        {scenes.map((scene, index) => {
          const sceneId = `${id}-${scene.id}`;
          const capability = getCampaignModelCapability(scene.connector, scene.model);
          return (
            <li key={scene.id} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">Scene {index + 1}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Move scene ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => onChange(moveStudioScene(scenes, scene.id, -1))}
                >
                  Move up
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Move scene ${index + 1} down`}
                  disabled={index === scenes.length - 1}
                  onClick={() => onChange(moveStudioScene(scenes, scene.id, 1))}
                >
                  Move down
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={scenes.length >= 30}
                  onClick={() => onChange(duplicateStudioScene(scenes, scene.id, randomUUID()))}
                >
                  Duplicate
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onChange(scenes.filter((value) => value.id !== scene.id))}
                >
                  Delete
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`${sceneId}-title`}>Title</Label>
                  <Input
                    nativeInput
                    id={`${sceneId}-title`}
                    value={scene.title}
                    maxLength={160}
                    onChange={(event) => update(scene.id, { title: event.currentTarget.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`${sceneId}-duration`}>Seconds</Label>
                  <Input
                    nativeInput
                    id={`${sceneId}-duration`}
                    type="number"
                    min={1}
                    max={30}
                    value={scene.durationSeconds}
                    onChange={(event) =>
                      update(scene.id, { durationSeconds: event.currentTarget.valueAsNumber })
                    }
                  />
                </div>
              </div>
              <div>
                <Label htmlFor={`${sceneId}-trim`}>Trim start (seconds into source)</Label>
                <Input
                  nativeInput
                  id={`${sceneId}-trim`}
                  type="number"
                  min={0}
                  step="0.1"
                  value={scene.startSeconds ?? 0}
                  onChange={(event) =>
                    update(scene.id, { startSeconds: event.currentTarget.valueAsNumber })
                  }
                />
              </div>
              <details className="space-y-2">
                <summary className="text-sm font-medium">
                  Timed captions ({scene.captions?.length ?? 0})
                </summary>
                <p className="text-xs text-muted-foreground">
                  Times are relative to the start of this scene.
                </p>
                {/* Captions have no persisted IDs; these controlled rows follow their wire positions. */}
                {(scene.captions ?? []).map((caption, captionIndex) => (
                  <div
                    // oxlint-disable-next-line react/no-array-index-key -- Caption rows are controlled and the wire format has positional identity.
                    key={captionIndex}
                    className="grid grid-cols-[1fr_1fr] gap-2 rounded-md border border-border p-2"
                  >
                    {(["start", "end"] as const).map((field) => (
                      <div key={field}>
                        <Label htmlFor={`${sceneId}-caption-${captionIndex}-${field}`}>
                          {field === "start" ? "Start" : "End"} seconds
                        </Label>
                        <Input
                          nativeInput
                          id={`${sceneId}-caption-${captionIndex}-${field}`}
                          type="number"
                          min={0}
                          max={scene.durationSeconds}
                          step="0.1"
                          value={caption[field]}
                          onChange={(event) =>
                            update(scene.id, {
                              captions: scene.captions?.map((value, i) =>
                                i === captionIndex
                                  ? { ...value, [field]: event.currentTarget.valueAsNumber }
                                  : value,
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                    <div className="col-span-2">
                      <Label htmlFor={`${sceneId}-caption-${captionIndex}-text`}>
                        Caption text
                      </Label>
                      <Input
                        nativeInput
                        id={`${sceneId}-caption-${captionIndex}-text`}
                        maxLength={200}
                        value={caption.text}
                        onChange={(event) =>
                          update(scene.id, {
                            captions: scene.captions?.map((value, i) =>
                              i === captionIndex
                                ? { ...value, text: event.currentTarget.value }
                                : value,
                            ),
                          })
                        }
                      />
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        update(scene.id, {
                          captions: scene.captions?.filter((_, i) => i !== captionIndex),
                        })
                      }
                    >
                      Remove caption
                    </Button>
                  </div>
                ))}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={(scene.captions?.length ?? 0) >= 200}
                  onClick={() =>
                    update(scene.id, {
                      captions: [
                        ...(scene.captions ?? []),
                        { start: 0, end: scene.durationSeconds, text: "" },
                      ],
                    })
                  }
                >
                  Add caption
                </Button>
              </details>
              {(["prompt", "narration", "onScreenText"] as const).map((field) => (
                <div key={field}>
                  <Label htmlFor={`${sceneId}-${field}`}>
                    {field === "prompt"
                      ? "Visual prompt"
                      : field === "narration"
                        ? "Narration"
                        : "On-screen text"}
                  </Label>
                  <Textarea
                    id={`${sceneId}-${field}`}
                    value={scene[field]}
                    maxLength={field === "prompt" ? 8000 : field === "narration" ? 4000 : 200}
                    onChange={(event) => update(scene.id, { [field]: event.currentTarget.value })}
                  />
                </div>
              ))}
              <div>
                <Label htmlFor={`${sceneId}-reference`}>Reference image</Label>
                <Input
                  nativeInput
                  id={`${sceneId}-reference`}
                  value={scene.referenceImage ?? ""}
                  placeholder="Workspace image path or HTTPS URL"
                  onChange={(event) =>
                    update(scene.id, { referenceImage: event.currentTarget.value || null })
                  }
                />
              </div>
              <div>
                <Label htmlFor={`${sceneId}-model`}>Provider and model</Label>
                <select
                  id={`${sceneId}-model`}
                  className="w-full rounded-md border border-input bg-background p-2 text-sm"
                  value={`${scene.connector}:${scene.model}`}
                  onChange={(event) => {
                    const selected = CAMPAIGN_MODEL_CAPABILITIES.find(
                      (entry) => `${entry.connector}:${entry.model}` === event.currentTarget.value,
                    );
                    if (selected)
                      update(scene.id, {
                        connector: selected.connector,
                        model: selected.model,
                        durationSeconds: selected.defaultDuration ?? scene.durationSeconds,
                        resolution: selected.defaultResolution ?? "",
                        generateAudio: false,
                        referenceImage:
                          selected.firstFrame === "unsupported" ? null : scene.referenceImage,
                      });
                  }}
                >
                  <option value=":">Ask AI to recommend, or choose a model</option>
                  {!capability && (scene.connector || scene.model) && (
                    <option value={`${scene.connector}:${scene.model}`}>
                      {scene.connector} · {scene.model}
                    </option>
                  )}
                  {CAMPAIGN_MODEL_CAPABILITIES.filter((entry) => entry.kind === "video").map(
                    (entry) => (
                      <option
                        key={`${entry.connector}:${entry.model}`}
                        value={`${entry.connector}:${entry.model}`}
                      >
                        {entry.connector} · {entry.label}
                      </option>
                    ),
                  )}
                </select>
              </div>
              {capability && (
                <p className="text-xs text-muted-foreground">
                  Durations: {capability.durations.join(", ")} seconds.{" "}
                  {capability.firstFrame === "required"
                    ? "Requires a reference image."
                    : "Text-to-video; no reference image."}{" "}
                  <a
                    href={capability.documentationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Model details
                  </a>
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`${sceneId}-resolution`}>Resolution</Label>
                  <select
                    id={`${sceneId}-resolution`}
                    className="w-full rounded-md border border-input bg-background p-2 text-sm"
                    disabled={!capability || capability.resolutions.length === 0}
                    value={scene.resolution}
                    onChange={(event) =>
                      update(scene.id, { resolution: event.currentTarget.value })
                    }
                  >
                    <option value="">Provider default</option>
                    {capability?.resolutions.map((resolution) => (
                      <option key={resolution} value={resolution}>
                        {resolution}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor={`${sceneId}-allowance`}>Unknown-price allowance (USD)</Label>
                  <Input
                    nativeInput
                    id={`${sceneId}-allowance`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={scene.allowanceUsd ?? ""}
                    onChange={(event) =>
                      update(scene.id, {
                        allowanceUsd:
                          event.currentTarget.value === ""
                            ? null
                            : event.currentTarget.valueAsNumber,
                      })
                    }
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  disabled={capability?.audio !== "toggle"}
                  checked={scene.generateAudio}
                  onChange={(event) =>
                    update(scene.id, { generateAudio: event.currentTarget.checked })
                  }
                />
                Generate audio with this scene
              </label>
              {scene.connector === "muapi" && (
                <p className="text-xs text-muted-foreground">
                  MuAPI controls source audio. Assembly mutes it unless you select Retain source
                  sound when rendering.
                </p>
              )}
              <div>
                <Label htmlFor={`${sceneId}-variant`}>Selected variant</Label>
                <select
                  id={`${sceneId}-variant`}
                  className="w-full rounded-md border border-input bg-background p-2 text-sm"
                  value={scene.selectedAssetId ?? ""}
                  onChange={(event) =>
                    update(scene.id, { selectedAssetId: event.currentTarget.value || null })
                  }
                >
                  <option value="">Choose an asset</option>
                  {studioSceneVariants(assets, scene.id).map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.file} · {asset.approved ? "approved" : "needs review"}
                    </option>
                  ))}
                </select>
              </div>
              {environmentId && (
                <StudioVariantComparison
                  environmentId={environmentId}
                  assets={studioSceneVariants(assets, scene.id)}
                  selectedAssetId={scene.selectedAssetId}
                  onSelect={(assetId) => update(scene.id, { selectedAssetId: assetId })}
                />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
