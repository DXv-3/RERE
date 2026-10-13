import {
  CAMPAIGN_GENERATION_ASPECT_RATIOS,
  CAMPAIGN_GENERATION_DURATION_MAX,
  CAMPAIGN_GENERATION_DURATION_MIN,
  CAMPAIGN_GENERATION_PROMPT_MAX,
  CAMPAIGN_GENERATION_RESOLUTIONS,
  ThreadId,
  type Campaign,
  type CampaignClient,
  type CampaignGenerationBoard,
  type CampaignGenerationJob,
  type CampaignGenerationKind,
  type EnvironmentId,
} from "@t3tools/contracts";
import { findDoNotSay } from "@t3tools/shared/campaignRules";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";

import { randomUUID } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  KIND_LABEL,
  SETTINGS_PATH_TEXT,
  costPreview,
  emptyGenerationForm,
  folderChoices,
  formForKind,
  formFromImageJob,
  formToOptions,
  generationFormProblems,
  generationCapability,
  generatorFor,
  generatorLine,
  isLocalVideo,
  jobsForClient,
  localVideoLimits,
  type GenerationFormValues,
} from "./generation.logic";
import { FirstFramePicker } from "./FirstFramePicker";
import type { CampaignRun } from "./useCampaigns";

const EXPORT_FOLDER = "export-folder";

/**
 * Starts a picture or video for a campaign. It shows which service will make it, the client's brand
 * notes beside the description (with a live warning when the description uses a phrase on the
 * do-not-say list), what the client has spent this month, and says so plainly when the cost of this
 * job is not known. Starting spends the owner's money, so only an administrator reaches it; with no
 * generator set it explains where to set one and sends nothing.
 */
export function CampaignGenerateDialog({
  open,
  ...props
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly generation: CampaignGenerationBoard;
  readonly client: CampaignClient;
  readonly campaign: Campaign;
  /** The thread whose folder is offered first for the files. */
  readonly preferredThreadId: string | undefined;
  /** A finished image to start a video from ("Make A Video From This"). */
  readonly startFrom?: CampaignGenerationJob | null | undefined;
  readonly run: CampaignRun;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="max-w-3xl">
        <GenerateForm key={props.startFrom?.id ?? "new"} {...props} />
      </DialogPopup>
    </Dialog>
  );
}

function GenerateForm({
  environmentId,
  generation,
  client,
  campaign,
  preferredThreadId,
  startFrom,
  run,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly generation: CampaignGenerationBoard;
  readonly client: CampaignClient;
  readonly campaign: Campaign;
  readonly preferredThreadId: string | undefined;
  readonly startFrom?: CampaignGenerationJob | null | undefined;
  readonly run: CampaignRun;
  readonly onClose: () => void;
}) {
  const ids = {
    prompt: useId(),
    aspect: useId(),
    seconds: useId(),
    resolution: useId(),
    folder: useId(),
    firstFrame: useId(),
    allowance: useId(),
  };
  const [form, setForm] = useState<GenerationFormValues>(() =>
    startFrom
      ? formFromImageJob(startFrom, generatorFor(generation.settings, "video"))
      : emptyGenerationForm,
  );
  // A picture's own folder is where it is looked for, so a video made from it starts there.
  const [folder, setFolder] = useState<string>(startFrom?.sourceThreadId ?? EXPORT_FOLDER);
  const [allowance, setAllowance] = useState("");
  const [requestKey, setRequestKey] = useState(() => randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date().toISOString());

  const shells = useThreadShells();
  const threads = useMemo(
    () => folderChoices(shells, environmentId, preferredThreadId),
    [shells, environmentId, preferredThreadId],
  );
  // The preferred thread is the starting choice once the list knows it.
  const [folderTouched, setFolderTouched] = useState(startFrom?.sourceThreadId !== undefined);
  const chosenFolder =
    !folderTouched &&
    preferredThreadId !== undefined &&
    threads.some((t) => t.id === preferredThreadId)
      ? preferredThreadId
      : folder;
  const folderTitle =
    chosenFolder === EXPORT_FOLDER
      ? "The Export Folder From Settings"
      : (threads.find((thread) => thread.id === chosenFolder)?.title ?? "A thread");

  const update = (patch: Partial<GenerationFormValues>) => {
    setForm((current) => ({ ...current, ...patch }));
    setRequestKey(randomUUID());
  };
  const choice = generatorFor(generation.settings, form.kind);
  const capability = generationCapability(form, choice);
  const showFrame =
    form.kind === "video" &&
    (isLocalVideo(form.kind, choice) ||
      capability?.firstFrame === "required" ||
      (choice.kind === "ready" &&
        !choice.model.trim() &&
        (choice.generator === "fal" || choice.generator === "muapi")));
  const flagged = findDoNotSay(form.prompt, client.doNotSay);
  const localVideo = isLocalVideo(form.kind, choice);
  const limits = localVideo && choice.kind === "ready" ? localVideoLimits(choice.model) : null;
  const problems = generationFormProblems(form, choice);
  const clientJobs = useMemo(
    () => jobsForClient(generation.jobs, client.id),
    [generation.jobs, client.id],
  );
  const spend = generation.spend.find((entry) => entry.clientId === client.id);
  const preview =
    choice.kind === "ready"
      ? costPreview({
          clientName: client.name,
          spend,
          jobs: clientJobs,
          choice,
          form,
          nowIso: now,
          ...(allowance.trim() ? { allowanceUsd: Number(allowance) } : {}),
        })
      : null;
  const canSend = choice.kind === "ready" && problems.length === 0 && preview?.refusal === null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend || pending) return;
    setPending(true);
    setError(null);
    const outcome = await run({
      command: "generation.start",
      kind: form.kind,
      clientId: client.id,
      campaignId: campaign.id,
      prompt: form.prompt.trim(),
      options: formToOptions(form, choice),
      requestKey,
      ...(preview?.costUnknown ? { allowanceUsd: Number(allowance) } : {}),
      ...(chosenFolder === EXPORT_FOLDER ? {} : { sourceThreadId: ThreadId.make(chosenFolder) }),
    });
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    onClose();
  };

  const notes = client.brandNotes.trim();
  return (
    <form onSubmit={(event) => void submit(event)} className="contents">
      <DialogHeader>
        <DialogTitle>Generate</DialogTitle>
        <DialogDescription>
          Make a picture or a video for {campaign.name}, a campaign of {client.name}. It starts
          right away, and what it costs counts toward {client.name}'s monthly limit.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="space-y-4">
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-muted-foreground">What To Make</legend>
              <div className="flex gap-2">
                {(["image", "video"] as const satisfies ReadonlyArray<CampaignGenerationKind>).map(
                  (kind) => (
                    <Button
                      key={kind}
                      type="button"
                      size="sm"
                      variant={form.kind === kind ? "default" : "outline"}
                      aria-pressed={form.kind === kind}
                      onClick={() => {
                        setForm((current) =>
                          formForKind(current, kind, generatorFor(generation.settings, kind)),
                        );
                        setRequestKey(randomUUID());
                      }}
                    >
                      {KIND_LABEL[kind]}
                    </Button>
                  ),
                )}
              </div>
              <p className="text-xs text-muted-foreground" role="status">
                {generatorLine(choice)} {capability ? `Model: ${capability.model}.` : ""}
              </p>
            </fieldset>

            {choice.kind === "none" ? (
              <Alert variant="info">
                <AlertDescription>
                  No {form.kind === "image" ? "image" : "video"} generator is set, so nothing can be
                  made yet. An administrator chooses one in {SETTINGS_PATH_TEXT}.{" "}
                  <Link
                    to="/settings/connections"
                    className="underline underline-offset-2"
                    onClick={onClose}
                  >
                    Open Connections
                  </Link>
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={ids.prompt}>
                    {localVideo ? "Describe The Motion" : "Describe It"}
                  </Label>
                  <Textarea
                    id={ids.prompt}
                    autoFocus
                    value={form.prompt}
                    maxLength={Math.min(
                      CAMPAIGN_GENERATION_PROMPT_MAX,
                      capability?.maxPromptLength ?? CAMPAIGN_GENERATION_PROMPT_MAX,
                    )}
                    disabled={pending}
                    placeholder={
                      localVideo
                        ? "How things move, in plain words. For example: the barista hands over the cup and steam rises."
                        : "Subject, setting, light and style, in plain words."
                    }
                    onChange={(event) => update({ prompt: event.currentTarget.value })}
                  />
                  {flagged.length > 0 ? (
                    <p
                      role="alert"
                      className="flex items-start gap-1.5 text-xs text-warning-foreground"
                    >
                      <AlertTriangleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        This uses {flagged.length === 1 ? "a phrase" : "phrases"} on {client.name}
                        's do-not-say list: {flagged.map((phrase) => `"${phrase}"`).join(", ")}.
                        Take {flagged.length === 1 ? "it" : "them"} out, or it may end up in the
                        result.
                      </span>
                    </p>
                  ) : null}
                </div>

                {showFrame ? (
                  <FirstFramePicker
                    environmentId={environmentId}
                    threadId={chosenFolder === EXPORT_FOLDER ? undefined : chosenFolder}
                    value={form.firstFrame}
                    disabled={pending}
                    inputId={ids.firstFrame}
                    onChange={(path) => update({ firstFrame: path, firstFrameJobId: "" })}
                  />
                ) : null}
                {localVideo ? (
                  <p className="text-xs text-muted-foreground">
                    A video takes about 3 to 6 minutes once it starts, and waits until the graphics
                    card has room. It runs best overnight.
                  </p>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.aspect}>Shape</Label>
                    <Select
                      value={form.aspectRatio}
                      onValueChange={(next) =>
                        update({ aspectRatio: next as GenerationFormValues["aspectRatio"] })
                      }
                    >
                      <SelectTrigger
                        id={ids.aspect}
                        size="sm"
                        disabled={pending || capability?.aspectRatios.length === 0}
                      >
                        <SelectValue>
                          {capability?.aspectRatios.length === 0
                            ? "From source image"
                            : form.aspectRatio}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {(capability?.aspectRatios ?? CAMPAIGN_GENERATION_ASPECT_RATIOS).map(
                          (ratio) => (
                            <SelectItem hideIndicator key={ratio} value={ratio}>
                              {ratio}
                            </SelectItem>
                          ),
                        )}
                      </SelectPopup>
                    </Select>
                  </div>
                  {form.kind === "video" ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor={ids.seconds}>Length In Seconds</Label>
                        <Input
                          id={ids.seconds}
                          nativeInput
                          type="number"
                          inputMode="numeric"
                          min={
                            limits?.min ??
                            capability?.durations[0] ??
                            CAMPAIGN_GENERATION_DURATION_MIN
                          }
                          max={
                            limits?.max ??
                            capability?.durations.at(-1) ??
                            CAMPAIGN_GENERATION_DURATION_MAX
                          }
                          value={form.durationSeconds}
                          disabled={pending}
                          onChange={(event) =>
                            update({ durationSeconds: event.currentTarget.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={ids.resolution}>Quality</Label>
                        <Select
                          value={form.resolution}
                          onValueChange={(next) =>
                            update({ resolution: next as GenerationFormValues["resolution"] })
                          }
                        >
                          <SelectTrigger
                            id={ids.resolution}
                            size="sm"
                            disabled={pending || capability?.resolutions.length === 0}
                          >
                            <SelectValue>
                              {capability?.resolutions.length === 0
                                ? "Provider default"
                                : form.resolution}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {(
                              limits?.resolutions ??
                              capability?.resolutions ??
                              CAMPAIGN_GENERATION_RESOLUTIONS
                            ).map((resolution) => (
                              <SelectItem hideIndicator key={resolution} value={resolution}>
                                {resolution}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    </>
                  ) : null}
                </div>
                {form.kind === "video" &&
                !localVideo &&
                (!capability || capability.audio === "toggle") ? (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.generateAudio}
                      disabled={pending}
                      onCheckedChange={(checked) => update({ generateAudio: checked === true })}
                    />
                    Include Sound
                  </label>
                ) : null}

                {form.kind === "video" && capability && (
                  <p className="text-xs text-muted-foreground">
                    Supported lengths: {capability.durations.join(", ")} seconds.{" "}
                    {capability.audio === "provider-default"
                      ? "This provider controls source audio; Studio can mute it during assembly."
                      : capability.audio === "unsupported"
                        ? "This model has no audio generation control."
                        : ""}
                  </p>
                )}
                {problems.length > 0 && form.prompt.trim() && (
                  <ul className="space-y-1 text-xs text-destructive-foreground" role="alert">
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor={ids.folder}>Save Files In</Label>
                  <Select
                    value={chosenFolder}
                    onValueChange={(next) => {
                      setFolderTouched(true);
                      setFolder(String(next));
                      // A picture is looked for in the chosen folder, so a new folder means a new choice.
                      if (String(next) !== chosenFolder)
                        update({ firstFrame: "", firstFrameJobId: "" });
                    }}
                  >
                    <SelectTrigger id={ids.folder} size="sm" disabled={pending}>
                      <SelectValue>{folderTitle}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem hideIndicator value={EXPORT_FOLDER}>
                        The Export Folder From Settings
                      </SelectItem>
                      {threads.map((thread) => (
                        <SelectItem hideIndicator key={thread.id} value={thread.id}>
                          {thread.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    A thread's folder lets you open the file here and attach it to posts that can be
                    uploaded. The export folder only works if one is set in {SETTINGS_PATH_TEXT}.
                  </p>
                </div>

                {preview?.costUnknown && (
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.allowance}>Unknown-price allowance (USD)</Label>
                    <Input
                      nativeInput
                      id={ids.allowance}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={allowance}
                      disabled={pending}
                      onChange={(event) => {
                        setAllowance(event.currentTarget.value);
                        setRequestKey(randomUUID());
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Starting approves this allowance and reserves it against the monthly limit. It
                      is not a provider quote or billing ceiling.
                    </p>
                  </div>
                )}
                {preview !== null ? (
                  <div className="space-y-1 text-xs" aria-live="polite">
                    <p>{preview.spendLine}</p>
                    <p className={preview.costUnknown ? "font-medium" : "text-muted-foreground"}>
                      {preview.costLine}
                    </p>
                    {preview.refusal !== null ? (
                      <p role="alert" className="text-destructive-foreground">
                        {preview.refusal}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <aside
            aria-label={`Brand notes for ${client.name}`}
            className="space-y-3 text-xs md:border-s md:ps-5"
          >
            <div className="space-y-1">
              <h3 className="font-medium text-muted-foreground">Brand Notes For {client.name}</h3>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {notes === "" ? "None recorded." : notes}
              </p>
            </div>
            <div className="space-y-1">
              <h3 className="font-medium text-muted-foreground">Do Not Say</h3>
              {client.doNotSay.length === 0 ? (
                <p>Nothing is listed.</p>
              ) : (
                <ul className="max-h-32 list-disc space-y-0.5 overflow-y-auto ps-4">
                  {client.doNotSay.map((phrase) => (
                    <li key={phrase} className={flagged.includes(phrase) ? "font-semibold" : ""}>
                      {phrase}
                      {flagged.includes(phrase) ? " (in your description)" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !canSend}>
          {pending ? <Spinner size="sm" /> : null}
          {preview?.costUnknown ? "Approve Allowance And Generate" : "Start Generating"}
        </Button>
      </DialogFooter>
    </form>
  );
}
