import { randomUUID } from "../../lib/utils";
import {
  ThreadId,
  type ContentStudio,
  type EnvironmentId,
  type StudioCommand,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { useAssetUrlState } from "../../assets/assetUrls";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

function RenderPreview({
  environmentId,
  render,
}: {
  readonly environmentId: EnvironmentId;
  readonly render: ContentStudio["renders"][number];
}) {
  const asset = useAssetUrlState(
    environmentId,
    render.file
      ? { _tag: "media-file", threadId: ThreadId.make(render.sourceThreadId), path: render.file }
      : null,
  );
  return asset._tag === "Success" ? (
    <video
      className="max-h-80 w-full rounded-md bg-black"
      src={asset.url}
      controls
      preload="metadata"
      aria-label={`Render revision ${render.revision}`}
    />
  ) : (
    <p className="text-xs text-muted-foreground">
      {asset._tag === "Failure"
        ? "The render preview could not be loaded. Open the source thread to inspect the file."
        : render.file
          ? "Loading render preview…"
          : render.status}
    </p>
  );
}

export function CampaignStudioRenders({
  studio,
  environmentId,
  busy,
  canUseSaved,
  isAdministrator,
  act,
  onRevise,
}: {
  readonly studio: ContentStudio;
  readonly environmentId: EnvironmentId;
  readonly busy: boolean;
  readonly canUseSaved: boolean;
  readonly isAdministrator: boolean;
  readonly act: (command: StudioCommand) => Promise<boolean>;
  readonly onRevise: () => void;
}) {
  const id = useId();
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "1:1" | "16:9">("9:16");
  const [keepSourceAudio, setKeepSourceAudio] = useState(false);
  const [fit, setFit] = useState<"crop" | "pad" | null>("crop");
  const [audioAssetId, setAudioAssetId] = useState("");
  const [caption, setCaption] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [allowance, setAllowance] = useState("");
  const [approvedNarration, setApprovedNarration] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => randomUUID());
  const narration = studio.scenes
    .map((scene) => scene.narration.trim())
    .filter(Boolean)
    .join("\n\n");
  const [requestNarration, setRequestNarration] = useState(narration);
  if (requestNarration !== narration) {
    setRequestNarration(narration);
    setRequestId(randomUUID());
    setApprovedNarration(null);
  }
  const narrationApproved = approvedNarration === narration;
  const unresolvedNarration = studio.narrations?.find(
    (attempt) =>
      attempt.text === narration &&
      attempt.sourceThreadId === studio.brief.sourceThreadId &&
      (attempt.status === "uncertain" ||
        attempt.status === "submitting" ||
        attempt.status === "preflight"),
  );
  return (
    <section aria-label="Render and review" className="space-y-4">
      <h3 className="text-sm font-semibold">Render and review</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor={`${id}-ratio`}>Format</Label>
          <select
            id={`${id}-ratio`}
            className="rounded-md border border-input bg-background p-2 text-sm"
            value={aspectRatio}
            onChange={(event) => {
              const next = event.currentTarget.value as typeof aspectRatio;
              setAspectRatio(next);
              setFit(next === "9:16" ? "crop" : null);
            }}
          >
            <option value="9:16">Portrait 9:16</option>
            <option value="1:1">Square 1:1</option>
            <option value="16:9">Landscape 16:9</option>
          </select>
        </div>
        <div>
          <Label htmlFor={`${id}-fit`}>Fit</Label>
          <select
            id={`${id}-fit`}
            className="rounded-md border border-input bg-background p-2 text-sm"
            value={fit ?? ""}
            onChange={(event) =>
              setFit(
                event.currentTarget.value ? (event.currentTarget.value as "crop" | "pad") : null,
              )
            }
          >
            <option value="" disabled>
              Choose crop or pad
            </option>
            <option value="crop">Crop to fill</option>
            <option value="pad">Pad to fit</option>
          </select>
        </div>
        <div>
          <Label htmlFor={`${id}-audio`}>Audio track</Label>
          <select
            id={`${id}-audio`}
            className="max-w-56 rounded-md border border-input bg-background p-2 text-sm"
            value={audioAssetId}
            onChange={(event) => setAudioAssetId(event.currentTarget.value)}
          >
            <option value="">No added audio track</option>
            {studio.assets
              .filter((asset) => asset.kind === "audio" && asset.approved)
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.file}
                </option>
              ))}
          </select>
        </div>
        <Button
          size="sm"
          disabled={busy || !canUseSaved || studio.scenes.length === 0 || fit === null}
          onClick={() =>
            void act({
              command: "studio.render",
              campaignId: studio.campaignId,
              expectedRevision: studio.revision,
              aspectRatio,
              ...(fit ? { fit } : {}),
              keepSourceAudio,
              ...(audioAssetId ? { audioAssetId } : {}),
            })
          }
        >
          Render selected variants
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={keepSourceAudio}
          onChange={(event) => setKeepSourceAudio(event.currentTarget.checked)}
        />
        Retain source sound (off by default)
      </label>
      <p className="text-xs text-muted-foreground">
        Approve the selected scene assets in Library before rendering. On-screen text is included in
        the cut.
      </p>
      {narration && (
        <details className="space-y-3 rounded-md border border-border p-3">
          <summary className="text-sm font-medium">Narration · ElevenLabs</summary>
          <p className="whitespace-pre-wrap text-sm">{narration}</p>
          <div>
            <Label htmlFor={`${id}-voice`}>Voice ID (optional)</Label>
            <Input
              nativeInput
              id={`${id}-voice`}
              value={voiceId}
              onChange={(event) => {
                setVoiceId(event.currentTarget.value);
                setApprovedNarration(null);
                setRequestId(randomUUID());
              }}
            />
          </div>
          <div>
            <Label htmlFor={`${id}-allowance`}>Narration allowance (USD)</Label>
            <Input
              nativeInput
              id={`${id}-allowance`}
              type="number"
              min={0}
              step="0.01"
              value={allowance}
              onChange={(event) => {
                setAllowance(event.currentTarget.value);
                setApprovedNarration(null);
                setRequestId(randomUUID());
              }}
            />
          </div>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={narrationApproved}
              onChange={(event) =>
                setApprovedNarration(event.currentTarget.checked ? narration : null)
              }
            />
            I approve creating this narration with ElevenLabs and reserving the allowance above.
            This is not a provider quote or billing ceiling.
          </label>
          {unresolvedNarration && (
            <p role="alert" className="text-sm">
              This narration already has an active or unresolved attempt. Review Activity and
              recover the existing request before approving another paid submission.
            </p>
          )}
          <Button
            size="sm"
            disabled={
              Boolean(unresolvedNarration) ||
              busy ||
              !canUseSaved ||
              !isAdministrator ||
              !narrationApproved ||
              !allowance ||
              !Number.isFinite(Number(allowance)) ||
              Number(allowance) <= 0
            }
            onClick={() =>
              void act({
                command: "studio.narrate",
                campaignId: studio.campaignId,
                expectedRevision: studio.revision,
                text: narration,
                ...(voiceId ? { voiceId } : {}),
                allowanceUsd: Number(allowance),
                requestId,
              }).then((ok) => {
                if (ok) {
                  setApprovedNarration(null);
                  setRequestId(randomUUID());
                }
              })
            }
          >
            Approve spend and create narration
          </Button>
        </details>
      )}
      <div>
        <Label htmlFor={`${id}-caption`}>Caption for exported post</Label>
        <Textarea
          id={`${id}-caption`}
          value={caption}
          maxLength={10000}
          onChange={(event) => setCaption(event.currentTarget.value)}
        />
      </div>
      <ul className="space-y-4">
        {studio.renders.toReversed().map((render) => (
          <li key={render.id} className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">
              Revision {render.revision} · {render.aspectRatio} · {render.status}
            </p>
            {render.file && <RenderPreview environmentId={environmentId} render={render} />}
            <p className="text-xs text-muted-foreground">
              {new Date(render.createdAt).toLocaleString()} ·{" "}
              {render.approvedAt ? "Approved" : "Not approved"}
            </p>
            {render.error && (
              <p role="alert" className="text-xs text-destructive-foreground">
                {render.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={onRevise}>
                Revise storyboard
              </Button>
              {isAdministrator && render.status === "completed" && (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void act({
                      command: "studio.render.approve",
                      campaignId: studio.campaignId,
                      renderId: render.id,
                      approved: !render.approvedAt,
                    })
                  }
                >
                  {render.approvedAt ? "Unapprove render" : "Approve this render"}
                </Button>
              )}
              {render.approvedAt && (
                <Button
                  size="xs"
                  disabled={
                    busy || !isAdministrator || !canUseSaved || studio.brief.platforms.length === 0
                  }
                  onClick={() =>
                    void act({
                      command: "studio.post",
                      campaignId: studio.campaignId,
                      renderId: render.id,
                      platforms: studio.brief.platforms,
                      captions: { default: caption, byPlatform: {} },
                    })
                  }
                >
                  Export to draft post
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
