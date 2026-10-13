import type { ContentStudio, EnvironmentId, StudioAsset, StudioCommand } from "@t3tools/contracts";
import { useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { CampaignMediaThumb, useOpenPostMedia } from "./CampaignPostMedia";
import { StudioAssetPreview } from "./StudioAssetPreview";
import { studioAssets, studioUploadKind } from "./studio.logic";

const EMPTY_ASSETS: readonly { campaignId: string; campaignName: string; asset: StudioAsset }[] =
  [];
const EMPTY_CAMPAIGNS: readonly { id: string; name: string }[] = [];

export function CampaignStudioLibrary({
  studio,
  environmentId,
  isAdministrator,
  busy,
  canUseSaved,
  act,
  onUploadFiles,
  reusableAssets = EMPTY_ASSETS,
  onReuseAsset,
  reuseCampaigns = EMPTY_CAMPAIGNS,
  reuseCampaignId = null,
  onReuseCampaignChange,
  reuseLoading = false,
  reuseError,
}: {
  readonly studio: ContentStudio;
  readonly environmentId: EnvironmentId;
  readonly isAdministrator: boolean;
  readonly busy: boolean;
  readonly canUseSaved: boolean;
  readonly reuseCampaigns?: readonly { id: string; name: string }[];
  readonly reuseCampaignId?: string | null;
  readonly onReuseCampaignChange?: (id: string | null) => void;
  readonly reuseLoading?: boolean;
  readonly reuseError?: string | null;
  readonly onUploadFiles?: (files: readonly File[]) => Promise<void>;
  readonly reusableAssets?: readonly {
    campaignId: string;
    campaignName: string;
    asset: StudioAsset;
  }[];
  readonly onReuseAsset?: (sourceCampaignId: string, assetId: string) => Promise<boolean>;
  readonly act: (command: StudioCommand) => Promise<boolean>;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [approval, setApproval] = useState("all");
  const [file, setFile] = useState("");
  const [importKind, setImportKind] = useState<"image" | "video" | "audio">("video");
  const [transferring, setTransferring] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [transferMessage, setTransferMessage] = useState("");
  const transferLock = useRef(false);
  const unavailable = busy || transferring || !canUseSaved;
  const upload = async (files: readonly File[]) => {
    if (!onUploadFiles || unavailable || transferLock.current || files.length === 0) return;
    const invalid = files.filter(
      (candidate) => studioUploadKind(candidate) === null || candidate.size === 0,
    );
    if (invalid.length) {
      setTransferMessage(
        `Choose supported, non-empty image, video or audio files. Not uploaded: ${invalid.map((candidate) => candidate.name).join(", ")}`,
      );
      return;
    }
    transferLock.current = true;
    setTransferring(true);
    setTransferMessage(`Uploading ${files.length} ${files.length === 1 ? "file" : "files"}…`);
    try {
      await onUploadFiles(files);
      setTransferMessage("Files added to the library.");
    } catch (error) {
      setTransferMessage(
        error instanceof Error
          ? error.message
          : "Upload could not be confirmed. Refresh the library before retrying.",
      );
    } finally {
      transferLock.current = false;
      setTransferring(false);
    }
  };
  const reuse = async (sourceCampaignId: string, assetId: string) => {
    if (!onReuseAsset || unavailable || transferLock.current) return;
    transferLock.current = true;
    setTransferring(true);
    setTransferMessage("");
    try {
      const ok = await onReuseAsset(sourceCampaignId, assetId);
      setTransferMessage(
        ok
          ? "Asset copied to this campaign. Review and approve the new copy."
          : "Asset could not be added. Refresh the library before retrying.",
      );
    } catch (error) {
      setTransferMessage(
        error instanceof Error
          ? error.message
          : "Asset reuse could not be confirmed. Refresh before retrying.",
      );
    } finally {
      transferLock.current = false;
      setTransferring(false);
    }
  };
  const reusable = reusableAssets.filter(
    ({ campaignId, asset }) =>
      campaignId !== studio.campaignId &&
      (!onReuseCampaignChange || campaignId === reuseCampaignId) &&
      asset.approved &&
      studioAssets([asset], search, kind).length > 0,
  );
  const openMedia = useOpenPostMedia(environmentId);
  const assets = studioAssets(studio.assets, search, kind).filter(
    (asset) => approval === "all" || asset.approved === (approval === "approved"),
  );
  return (
    <section aria-label="Asset library" className="space-y-4">
      {onUploadFiles && (
        <div
          className={`space-y-2 rounded-lg border border-dashed p-4 ${dragging ? "border-primary bg-muted" : "border-border"}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = unavailable ? "none" : "copy";
              setDragging(!unavailable);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(Array.from(event.dataTransfer.files));
          }}
        >
          <Label htmlFor={`${id}-upload`}>
            Drop image, video or audio files here, or choose files
          </Label>
          <input
            id={`${id}-upload`}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.m4v,.mp3,.wav,.m4a,.aac,.ogg,.flac"
            disabled={unavailable}
            className="block w-full text-sm"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void upload(files);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Files are uploaded to the linked workspace. Originals remain unchanged.
          </p>
          {!canUseSaved && (
            <p className="text-xs">Save your brief and link a thread before adding files.</p>
          )}
        </div>
      )}
      {transferMessage && (
        <p role="status" className="text-sm">
          {transferMessage}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor={`${id}-search`}>Search files, prompts, providers or models</Label>
          <Input
            nativeInput
            id={`${id}-search`}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-kind`}>Media type</Label>
          <select
            id={`${id}-kind`}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            value={kind}
            onChange={(event) => setKind(event.currentTarget.value)}
          >
            <option value="all">All media</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="audio">Audio</option>
          </select>
        </div>
        <div>
          <Label htmlFor={`${id}-approval`}>Approval state</Label>
          <select
            id={`${id}-approval`}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            value={approval}
            onChange={(event) => setApproval(event.currentTarget.value)}
          >
            <option value="all">All assets</option>
            <option value="approved">Approved</option>
            <option value="unapproved">Needs review</option>
          </select>
        </div>
      </div>
      <form
        className="space-y-2 rounded-lg border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void act({
            command: "studio.import",
            campaignId: studio.campaignId,
            expectedRevision: studio.revision,
            file: file.trim(),
            kind: importKind,
          }).then((ok) => {
            if (ok) setFile("");
          });
        }}
      >
        <Label htmlFor={`${id}-file`}>Import a file from the linked thread’s workspace</Label>
        <Input
          nativeInput
          id={`${id}-file`}
          value={file}
          placeholder="assets/product.mp4"
          onChange={(event) => setFile(event.currentTarget.value)}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs">
            File type{" "}
            <select
              aria-label="Import file type"
              className="rounded-md border border-input bg-background p-2"
              value={importKind}
              onChange={(event) => setImportKind(event.currentTarget.value as typeof importKind)}
            >
              <option value="video">Video</option>
              <option value="image">Image</option>
              <option value="audio">Audio</option>
            </select>
          </label>
          <Button size="sm" disabled={unavailable || !file.trim()} type="submit">
            Import asset
          </Button>
        </div>
      </form>
      {assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No matching assets. Import a workspace file or review a scene generation.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {assets.map((asset) => (
            <li key={asset.id} className="space-y-2 rounded-lg border border-border p-3">
              <button
                type="button"
                className="flex w-full items-center gap-3 text-left"
                onClick={() => openMedia(asset.sourceThreadId, asset.file)}
              >
                <CampaignMediaThumb
                  environmentId={environmentId}
                  sourceThreadId={asset.sourceThreadId}
                  item={{ kind: "path", value: asset.file }}
                />
                <span className="min-w-0 break-all text-sm">{asset.file}</span>
              </button>
              {asset.kind === "audio" && (
                <StudioAssetPreview key={asset.id} environmentId={environmentId} asset={asset} />
              )}
              <p className="text-xs text-muted-foreground">
                {asset.connector || "Imported"} · {asset.model || asset.kind} ·{" "}
                {new Date(asset.createdAt).toLocaleDateString()}
              </p>
              {asset.prompt && <p className="line-clamp-3 text-xs">{asset.prompt}</p>}
              <details className="text-xs text-muted-foreground">
                <summary>Provenance</summary>
                <p className="break-all">Thread: {asset.sourceThreadId}</p>
                <p>Job: {asset.jobId ?? "Imported file"}</p>
                <p>Scene: {asset.sceneId ?? "Shared asset"}</p>
                {asset.provenance && (
                  <div className="space-y-1">
                    <p>Original campaign: {asset.provenance.campaignId}</p>
                    <p>Original asset: {asset.provenance.assetId}</p>
                    <p className="break-all">Original thread: {asset.provenance.sourceThreadId}</p>
                    <p className="break-all">Original file: {asset.provenance.file}</p>
                  </div>
                )}
              </details>
              <p className="text-xs">{asset.approved ? "Approved" : "Needs review"}</p>
              {isAdministrator && (
                <Button
                  size="xs"
                  disabled={busy || transferring}
                  onClick={() =>
                    void act({
                      command: "studio.asset.approve",
                      campaignId: studio.campaignId,
                      assetId: asset.id,
                      approved: !asset.approved,
                    })
                  }
                >
                  {asset.approved ? "Unapprove asset" : "Approve asset"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {onReuseAsset && (
        <section aria-label="Reuse approved assets" className="space-y-3">
          <h3 className="text-sm font-semibold">Approved assets from other campaigns</h3>
          <p className="text-xs text-muted-foreground">
            Copy an approved original without generating it again. Source history is retained;
            review and approve the new copy here.
          </p>
          {onReuseCampaignChange && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-reuse-campaign`}>Source campaign</Label>
              <select
                id={`${id}-reuse-campaign`}
                className="w-full rounded-md border border-input bg-background p-2 text-sm"
                value={reuseCampaignId ?? ""}
                disabled={transferring}
                onChange={(event) => onReuseCampaignChange(event.currentTarget.value || null)}
              >
                <option value="">Choose a campaign</option>
                {reuseCampaigns
                  .filter((campaign) => campaign.id !== studio.campaignId)
                  .map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {reuseLoading ? (
            <p role="status" className="text-xs">
              Loading approved assets…
            </p>
          ) : reuseError ? (
            <p role="alert" className="text-xs">
              {reuseError}
            </p>
          ) : reusable.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No matching approved assets in other campaigns.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {reusable.map(({ campaignId, campaignName, asset }) => (
                <li
                  key={`${campaignId}:${asset.id}`}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <p className="text-sm font-medium">{campaignName}</p>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 text-left"
                    onClick={() => openMedia(asset.sourceThreadId, asset.file)}
                  >
                    <CampaignMediaThumb
                      environmentId={environmentId}
                      sourceThreadId={asset.sourceThreadId}
                      item={{ kind: "path", value: asset.file }}
                    />
                    <span className="min-w-0 break-all text-xs">{asset.file}</span>
                  </button>
                  {asset.kind === "audio" && (
                    <StudioAssetPreview
                      key={asset.id}
                      environmentId={environmentId}
                      asset={asset}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {asset.connector || "Imported"} · {asset.model || asset.kind}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unavailable}
                    onClick={() => void reuse(campaignId, asset.id)}
                  >
                    Reuse in this campaign
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
