import {
  CAMPAIGN_CAPTION_MAX,
  CAMPAIGN_PINTEREST_TITLE_MAX,
  CAMPAIGN_PLATFORMS,
  CAMPAIGN_PLATFORM_LABELS,
  type Campaign,
  type CampaignApprovalMode,
  type CampaignClient,
  type CampaignConnectionState,
  type CampaignPlatform,
  type CampaignPost,
  type CampaignPublishLogEntry,
  type CampaignStorageState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, ExternalLinkIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { CampaignConfirmDialog } from "./CampaignConfirmDialog";
import {
  CampaignMediaThumb,
  mediaDisplayName,
  postMediaItems,
  useOpenPostMedia,
  type PostMediaItem,
} from "./CampaignPostMedia";
import {
  POST_STATUS_LABEL,
  approvalLine,
  availablePostActions,
  canEditPost,
  confirmationText,
  creatorLine,
  emptyPostForm,
  formIsChanged,
  formToPostContent,
  formToSaveInput,
  formatPostTime,
  modeInForce,
  modeLabel,
  parseMediaEntry,
  postProblems,
  postToForm,
  type PostAction,
  type PostForm as PostFormValues,
} from "./campaigns.logic";
import { fileLink, publicLinksState } from "./publicLinks.logic";
import type { CampaignRun } from "./useCampaigns";

const isPlatform = (value: string): value is CampaignPlatform =>
  (CAMPAIGN_PLATFORMS as ReadonlyArray<string>).includes(value);

const platformName = (value: string): string =>
  isPlatform(value) ? CAMPAIGN_PLATFORM_LABELS[value] : value;

const postKeyOf = (post: CampaignPost | null): string =>
  post === null ? "new" : `${post.id}:${post.updatedAt}`;

/** Files a new post starts with, for example what a generation just made. */
export interface PostPrefill {
  /** Changes for each new offer, so a second offer starts a fresh form. */
  readonly key: string;
  readonly mediaPaths: ReadonlyArray<string>;
  /** The thread whose folder holds the files, so they can be opened and uploaded. */
  readonly sourceThreadId?: string | undefined;
}

/** What a saved folder file's public link is, with a button that copies it. */
function FileLinkLine({
  post,
  path,
  name,
}: {
  readonly post: CampaignPost;
  readonly path: string;
  readonly name: string;
}) {
  const link = fileLink(post, path);
  if (link.state === "missing") {
    return <span className="block text-xs text-muted-foreground">No public link yet</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs">
      <a
        className="min-w-0 truncate underline underline-offset-2"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {link.url}
      </a>
      <CopyLinkButton url={link.url} name={name} />
    </span>
  );
}

/** The link to a file with a button that copies it. */
function CopyLinkButton({ url, name }: { readonly url: string; readonly name: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "public link" });
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      aria-label={`Copy the public link to ${name}`}
      onClick={() => copyToClipboard(url, undefined)}
    >
      {isCopied ? "Copied" : "Copy Link"}
    </Button>
  );
}

function SectionLabel({ children }: { readonly children: string }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

/**
 * One post, open: its words, platforms, time and files, the problems that stop it from going out,
 * what happened when it was sent, and the actions its status allows. While it is a Draft or waits
 * for approval it can be edited; an edit saves it as a Draft, as the server does. With no `post`
 * it creates a new Draft in `campaign`.
 */
export function CampaignPostDialog({
  open,
  ...props
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly post: CampaignPost | null;
  readonly campaign: Campaign;
  readonly client: CampaignClient | undefined;
  readonly connection: CampaignConnectionState;
  readonly storage: CampaignStorageState;
  readonly log: ReadonlyArray<CampaignPublishLogEntry>;
  readonly isAdministrator: boolean;
  readonly run: CampaignRun;
  /** Only read for a new post (`post` is null). */
  readonly prefill?: PostPrefill | null | undefined;
  readonly onClose: () => void;
  /** A new post was saved; the screen can now open it by id. */
  readonly onCreated: (post: CampaignPost) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        {/* A different post, or a saved new one, starts a fresh form. */}
        <PostForm key={`${props.post?.id ?? "new"}:${props.prefill?.key ?? ""}`} {...props} />
      </DialogPopup>
    </Dialog>
  );
}

/** Mounted with the dialog, so every opening starts from the saved post. */
function PostForm({
  environmentId,
  post,
  campaign,
  client,
  connection,
  storage,
  log,
  isAdministrator,
  run,
  prefill,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly post: CampaignPost | null;
  readonly campaign: Campaign;
  readonly client: CampaignClient | undefined;
  readonly connection: CampaignConnectionState;
  readonly storage: CampaignStorageState;
  readonly log: ReadonlyArray<CampaignPublishLogEntry>;
  readonly isAdministrator: boolean;
  readonly run: CampaignRun;
  readonly prefill?: PostPrefill | null | undefined;
  readonly onClose: () => void;
  readonly onCreated: (post: CampaignPost) => void;
}) {
  const ids = {
    caption: useId(),
    schedule: useId(),
    title: useId(),
    link: useId(),
    media: useId(),
    note: useId(),
  };
  const openMedia = useOpenPostMedia(environmentId);
  const [form, setForm] = useState<PostFormValues>(
    post === null
      ? { ...emptyPostForm, mediaPaths: prefill?.mediaPaths ?? emptyPostForm.mediaPaths }
      : postToForm(post),
  );
  // The folder the files are in: the post's thread, or for a new post the one that made them.
  const threadId = post === null ? prefill?.sourceThreadId : post.sourceThreadId;
  const [loadedKey, setLoadedKey] = useState(postKeyOf(post));
  const [mediaText, setMediaText] = useState("");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [working, setWorking] = useState<PostAction | "save" | "upload" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PostAction | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [now] = useState(() => new Date());

  const editable = post === null || canEditPost(post.status);
  const dirty = post === null ? true : formIsChanged(form, post);

  // A change that arrives from the server loads into the form unless there are edits to keep.
  const postKey = postKeyOf(post);
  if (postKey !== loadedKey && !dirty && post !== null) {
    setLoadedKey(postKey);
    setForm(postToForm(post));
  }
  const changedUnderneath = postKey !== loadedKey && dirty && editable;

  const mode: CampaignApprovalMode = modeInForce(client, campaign).mode;
  const shown = post === null ? formToPostContent(form) : editable ? formToPostContent(form) : post;
  const problems = postProblems(shown, client);
  const actions =
    post === null ? [] : availablePostActions(post, { isAdministrator, mode, problems });
  const results = post === null ? [] : Object.entries(post.publishResults);
  const rows = post === null ? [] : log.filter((entry) => entry.postId === post.id);
  const approval = post === null ? null : approvalLine(post.approval);
  const media = postMediaItems(formToPostContent(form));
  const links = post === null ? null : publicLinksState({ post, storage, isAdministrator });
  const pinterest = form.platforms.includes("pinterest");

  const update = (patch: Partial<PostFormValues>) =>
    setForm((current) => ({ ...current, ...patch }));
  const togglePlatform = (platform: CampaignPlatform, on: boolean) =>
    update({
      platforms: on
        ? CAMPAIGN_PLATFORMS.filter((p) => p === platform || form.platforms.includes(p))
        : form.platforms.filter((p) => p !== platform),
    });

  const addMedia = () => {
    const entry = parseMediaEntry(mediaText);
    if (entry.kind === "invalid") {
      setMediaError(entry.message);
      return;
    }
    setMediaError(null);
    setMediaText("");
    if (entry.kind === "path") {
      if (!form.mediaPaths.includes(entry.value))
        update({ mediaPaths: [...form.mediaPaths, entry.value] });
    } else if (!form.mediaUrls.includes(entry.value)) {
      update({ mediaUrls: [...form.mediaUrls, entry.value] });
    }
  };
  const removeMedia = (item: PostMediaItem) =>
    update(
      item.kind === "path"
        ? { mediaPaths: form.mediaPaths.filter((value) => value !== item.value) }
        : { mediaUrls: form.mediaUrls.filter((value) => value !== item.value) },
    );

  const save = async () => {
    setWorking("save");
    setError(null);
    const outcome = await run({
      command: "post.save",
      post: formToSaveInput(form, {
        campaignId: campaign.id,
        ...(post === null ? {} : { postId: post.id }),
        ...(post === null && prefill?.sourceThreadId !== undefined
          ? { sourceThreadId: prefill.sourceThreadId }
          : {}),
      }),
    });
    setWorking(null);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    if (outcome.value.kind === "post") {
      setLoadedKey(postKeyOf(outcome.value.post));
      setForm(postToForm(outcome.value.post));
      if (post === null) onCreated(outcome.value.post);
    }
  };

  const uploadFiles = async () => {
    if (post === null) return;
    setWorking("upload");
    setError(null);
    const outcome = await run({ command: "post.uploadMedia", postId: post.id });
    setWorking(null);
    // The form is left as it is, so edits not yet saved are not lost; the links are kept on the
    // post and used when it is sent. The board stream brings them back, and they show per file.
    if (!outcome.ok) setError(outcome.message);
  };

  /** Ends this server's sharing of the post's files; the links stop working at once. */
  const stopSharing = async (): Promise<boolean> => {
    if (post === null) return false;
    setWorking("revoke");
    setError(null);
    const outcome = await run({ command: "post.revokeMedia", postId: post.id });
    setWorking(null);
    if (!outcome.ok) setError(outcome.message);
    return outcome.ok;
  };

  const perform = async (action: PostAction, text?: string): Promise<boolean> => {
    if (post === null) return false;
    setWorking(action);
    setError(null);
    const outcome = await run(
      action === "submit"
        ? { command: "post.submit", postId: post.id }
        : action === "approve"
          ? { command: "post.approve", postId: post.id }
          : action === "publishNow"
            ? { command: "post.publishNow", postId: post.id }
            : action === "retry"
              ? { command: "post.retry", postId: post.id }
              : action === "reject"
                ? { command: "post.reject", postId: post.id }
                : action === "delete"
                  ? { command: "post.delete", postId: post.id }
                  : { command: "post.requestChanges", postId: post.id, text: text ?? "" },
    );
    setWorking(null);
    if (!outcome.ok) {
      setError(outcome.message);
      return false;
    }
    if (action === "delete") onClose();
    if (action === "requestChanges") {
      setAsking(false);
      setNote("");
    }
    return true;
  };

  const start = (action: PostAction) => {
    if (action === "requestChanges") {
      setAsking((current) => !current);
      setError(null);
    } else if (confirmationText(action, mode, connection.connector) !== null) {
      setError(null);
      setConfirming(action);
    } else void perform(action);
  };

  const confirm =
    confirming === null ? null : confirmationText(confirming, mode, connection.connector);
  const busy = working !== null;
  const openFromThread = (item: PostMediaItem) => {
    if (item.kind === "path" && threadId !== undefined) {
      onClose();
      openMedia(threadId, item.value);
    }
  };

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2 pe-8">
          <DialogTitle>{post === null ? "New Post" : "Post"}</DialogTitle>
          {post !== null ? (
            <Badge variant={post.status === "failed" ? "error" : "secondary"} size="control">
              {post.status === "failed" ? <AlertTriangleIcon aria-hidden /> : null}
              {POST_STATUS_LABEL[post.status]}
            </Badge>
          ) : null}
        </div>
        <DialogDescription>
          {post === null
            ? `A new draft in ${campaign.name}.`
            : [campaign.name, creatorLine(post), approval, `Campaign mode: ${modeLabel(mode)}`]
                .filter(Boolean)
                .join(" · ")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-5">
          {post?.changeRequest ? (
            <Alert variant="info">
              <AlertDescription>
                <span className="font-medium">Changes were requested.</span> {post.changeRequest}
              </AlertDescription>
            </Alert>
          ) : null}
          {changedUnderneath ? (
            <Alert variant="warning">
              <AlertDescription>
                This post changed while you were editing it. Saving replaces that change with yours.
              </AlertDescription>
            </Alert>
          ) : null}
          {!editable && post !== null ? (
            <p className="text-xs text-muted-foreground">
              {post.status === "posted" || post.status === "publishing"
                ? "This post has gone out, so it cannot be edited."
                : "Only a Draft or a post waiting for approval can be edited. Request changes to send it back to Draft."}
            </p>
          ) : null}
          {problems.length > 0 && (editable || actions.some((a) => !a.enabled)) ? (
            <section aria-label="Problems" className="space-y-1">
              <SectionLabel>Fix Before It Can Go Out</SectionLabel>
              <ul className="space-y-1 text-sm">
                {problems.map((problem) => (
                  <li key={problem} className="flex items-start gap-2 text-warning-foreground">
                    <AlertTriangleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span>{problem}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-label="Platforms" className="space-y-2">
            <SectionLabel>Platforms</SectionLabel>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {CAMPAIGN_PLATFORMS.map((platform) => (
                <label key={platform} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.platforms.includes(platform)}
                    disabled={!editable || busy}
                    onCheckedChange={(checked) => togglePlatform(platform, checked === true)}
                  />
                  {CAMPAIGN_PLATFORM_LABELS[platform]}
                </label>
              ))}
            </div>
          </section>

          <section aria-label="Captions" className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor={ids.caption}>Default Caption</Label>
              <Textarea
                id={ids.caption}
                value={form.defaultCaption}
                maxLength={CAMPAIGN_CAPTION_MAX}
                readOnly={!editable}
                disabled={busy}
                onChange={(event) => update({ defaultCaption: event.currentTarget.value })}
              />
            </div>
            {form.platforms.map((platform) => (
              <div key={platform} className="space-y-1.5">
                <Label htmlFor={`${ids.caption}-${platform}`}>
                  {`${CAMPAIGN_PLATFORM_LABELS[platform]} Caption (Optional)`}
                </Label>
                <Textarea
                  id={`${ids.caption}-${platform}`}
                  size="sm"
                  value={form.platformCaptions[platform] ?? ""}
                  maxLength={CAMPAIGN_CAPTION_MAX}
                  readOnly={!editable}
                  disabled={busy}
                  placeholder="Leave empty to use the default caption"
                  onChange={(event) =>
                    update({
                      platformCaptions: {
                        ...form.platformCaptions,
                        [platform]: event.currentTarget.value,
                      },
                    })
                  }
                />
              </div>
            ))}
          </section>

          <section aria-label="Time" className="space-y-1.5">
            <Label htmlFor={ids.schedule}>Proposed Time</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={ids.schedule}
                nativeInput
                type="datetime-local"
                className="w-56"
                value={form.scheduledAt}
                readOnly={!editable}
                disabled={busy}
                onChange={(event) => update({ scheduledAt: event.currentTarget.value })}
              />
              {editable && form.scheduledAt !== "" ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={busy}
                  onClick={() => update({ scheduledAt: "" })}
                >
                  Clear Time
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {formatPostTime(formToPostContent(form).scheduledAt, now) ??
                  "No time set. Once approved it goes out right away."}
              </span>
            </div>
          </section>

          {pinterest ? (
            <section aria-label="Pinterest" className="space-y-2">
              <div className="space-y-1.5">
                <Label htmlFor={ids.title}>Pinterest Title</Label>
                <Input
                  id={ids.title}
                  nativeInput
                  value={form.title}
                  maxLength={CAMPAIGN_PINTEREST_TITLE_MAX}
                  readOnly={!editable}
                  disabled={busy}
                  onChange={(event) => update({ title: event.currentTarget.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {form.title.length} of {CAMPAIGN_PINTEREST_TITLE_MAX} characters.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={ids.link}>Pinterest Destination Link</Label>
                <Input
                  id={ids.link}
                  nativeInput
                  inputMode="url"
                  placeholder="https://"
                  value={form.destinationUrl}
                  readOnly={!editable}
                  disabled={busy}
                  onChange={(event) => update({ destinationUrl: event.currentTarget.value })}
                />
              </div>
            </section>
          ) : null}

          <section aria-label="Files" className="space-y-2">
            <SectionLabel>Images And Videos</SectionLabel>
            {media.length === 0 ? (
              <p className="text-xs text-muted-foreground">No files yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {media.map((item) => (
                  <li key={`${item.kind}:${item.value}`} className="flex items-center gap-3">
                    <CampaignMediaThumb
                      environmentId={environmentId}
                      sourceThreadId={threadId}
                      item={item}
                      className="size-10"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{mediaDisplayName(item)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.kind === "url" ? item.value : "In the project folder"}
                      </span>
                      {item.kind === "path" &&
                      post !== null &&
                      post.mediaPaths.includes(item.value) ? (
                        <FileLinkLine post={post} path={item.value} name={mediaDisplayName(item)} />
                      ) : null}
                    </span>
                    {item.kind === "url" ? (
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        render={<a href={item.value} target="_blank" rel="noopener noreferrer" />}
                      >
                        Open Link
                        <ExternalLinkIcon aria-hidden />
                      </Button>
                    ) : threadId !== undefined ? (
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        disabled={busy}
                        onClick={() => openFromThread(item)}
                      >
                        Open In Viewer
                      </Button>
                    ) : null}
                    {editable ? (
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Remove ${mediaDisplayName(item)}`}
                        disabled={busy}
                        onClick={() => removeMedia(item)}
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {threadId === undefined && media.some((item) => item.kind === "path") ? (
              <p className="text-xs text-muted-foreground">
                This post has no thread, so its folder files cannot be opened in the viewer.
              </p>
            ) : null}
            {links !== null && links.message !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                {links.canGet ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void uploadFiles()}
                  >
                    {working === "upload" ? <Spinner size="sm" /> : null}
                    Get Public Links
                  </Button>
                ) : null}
                {links.canStopSharing ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setConfirmingStop(true);
                    }}
                  >
                    {working === "revoke" ? <Spinner size="sm" /> : null}
                    Stop Sharing
                  </Button>
                ) : null}
                <span className="text-xs text-muted-foreground" role="status">
                  {links.message}
                </span>
              </div>
            ) : null}
            {editable ? (
              <div className="space-y-1">
                <Label htmlFor={ids.media} className="sr-only">
                  Add A File Path Or Link
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={ids.media}
                    nativeInput
                    value={mediaText}
                    placeholder="Folder path like campaigns/launch/reel.mp4, or an https link"
                    disabled={busy}
                    aria-invalid={mediaError !== null}
                    onChange={(event) => {
                      setMediaText(event.currentTarget.value);
                      setMediaError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addMedia();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || mediaText.trim() === ""}
                    onClick={addMedia}
                  >
                    <PlusIcon aria-hidden />
                    Add
                  </Button>
                </div>
                {mediaError ? (
                  <p role="alert" className="text-xs text-destructive-foreground">
                    {mediaError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          {results.length > 0 ? (
            <section aria-label="Results" className="space-y-1.5">
              <SectionLabel>What Happened When It Went Out</SectionLabel>
              <ul className="space-y-1 text-sm">
                {results.map(([platform, result]) => (
                  <li key={platform} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{platformName(platform)}</span>
                    <span>{result.success ? "Posted" : "Failed"}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatPostTime(result.at, now)}
                    </span>
                    {result.success && result.link ? (
                      <a
                        className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                        href={result.link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View Post
                        <ExternalLinkIcon aria-hidden className="size-3" />
                      </a>
                    ) : null}
                    {!result.success && result.error ? (
                      <span className="w-full text-xs text-destructive-foreground">
                        {result.error}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {rows.length > 0 ? (
            <section aria-label="Publish log" className="space-y-1.5">
              <SectionLabel>Publish Log</SectionLabel>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {rows.map((row) => (
                  <li key={row.id}>
                    {platformName(row.platform)}
                    {" · "}
                    {row.result === "success" ? "Success" : "Failure"}
                    {" · "}
                    {formatPostTime(row.at, now)}
                    {" · "}
                    {modeLabel(row.mode)}
                    {" · "}
                    {row.approvedBy === "person"
                      ? "Approved by a person"
                      : `Approved by the ${modeLabel(row.mode)} setting`}
                    {row.error ? ` · ${row.error}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {asking ? (
            <section aria-label="Request changes" className="space-y-1.5">
              <Label htmlFor={ids.note}>What Should Change?</Label>
              <Textarea
                id={ids.note}
                autoFocus
                value={note}
                maxLength={CAMPAIGN_CAPTION_MAX}
                disabled={busy}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">
                {post?.sourceThreadId === undefined
                  ? "This post has no agent thread, so the note is only saved on the post."
                  : "The note goes to the agent's thread and the post goes back to Draft."}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || note.trim() === ""}
                  onClick={() => void perform("requestChanges", note.trim())}
                >
                  {working === "requestChanges" ? <Spinner size="sm" /> : null}
                  Send Request
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAsking(false)}
                >
                  Cancel
                </Button>
              </div>
            </section>
          ) : null}

          {error && confirming === null && !confirmingStop ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter className="flex-wrap">
        {post !== null
          ? actions.map((state) => {
              const needsSave =
                dirty && editable && ["submit", "approve", "publishNow"].includes(state.action);
              const enabled = state.enabled && !needsSave && !busy;
              const reason = needsSave ? "Save your changes first." : state.reason;
              return (
                <span key={state.action} className="inline-flex flex-col items-start gap-0.5">
                  <Button
                    size="sm"
                    variant={
                      state.destructive
                        ? "destructive-outline"
                        : state.action === "approve" || state.action === "submit"
                          ? "default"
                          : "outline"
                    }
                    aria-disabled={!enabled}
                    aria-describedby={
                      reason === undefined ? undefined : `${ids.note}-${state.action}`
                    }
                    onClick={() => {
                      if (enabled) start(state.action);
                    }}
                  >
                    {working === state.action ? <Spinner size="sm" /> : null}
                    {state.label}
                  </Button>
                  {!enabled && reason !== undefined && !busy ? (
                    <span
                      id={`${ids.note}-${state.action}`}
                      className="max-w-44 text-2xs text-muted-foreground"
                    >
                      {reason}
                    </span>
                  ) : null}
                </span>
              );
            })
          : null}
        {editable ? (
          <Button
            size="sm"
            className="sm:ms-auto"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {working === "save" ? <Spinner size="sm" /> : null}
            {post === null ? "Save Draft" : "Save Changes"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost-muted" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
      <CampaignConfirmDialog
        open={confirming !== null && confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        destructive={confirming === "delete" || confirming === "reject"}
        pending={working !== null}
        error={confirming === null ? null : error}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming === null) return;
          const action = confirming;
          void perform(action).then((done) => {
            if (done) setConfirming(null);
          });
        }}
      />
      <CampaignConfirmDialog
        open={confirmingStop}
        title="Stop Sharing This Post's Files?"
        body="This server stops handing out this post's files. Their public links stop working at once, for anyone who has them, and are taken off the post. Getting public links again makes new ones."
        confirmLabel="Stop Sharing"
        destructive
        pending={working === "revoke"}
        error={confirmingStop ? error : null}
        onCancel={() => setConfirmingStop(false)}
        onConfirm={() => void stopSharing().then((done) => done && setConfirmingStop(false))}
      />
    </>
  );
}
