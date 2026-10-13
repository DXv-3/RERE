import type { EnvironmentId, StudioAsset } from "@t3tools/contracts";
import { useState } from "react";
import { useAssetUrlState } from "../../assets/assetUrls";

/** Signed media URLs retain the asset's owning thread, including reused originals. */
export function StudioAssetPreview({
  environmentId,
  asset,
}: {
  readonly environmentId: EnvironmentId;
  readonly asset: StudioAsset;
}) {
  const [failed, setFailed] = useState(false);
  const media = useAssetUrlState(environmentId, {
    _tag: "media-file",
    threadId: asset.sourceThreadId,
    path: asset.file,
  });
  if (failed || media._tag === "Failure")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Preview unavailable. Open the source file to inspect it.
      </p>
    );
  if (media._tag !== "Success")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading preview…
      </p>
    );
  if (asset.kind === "audio")
    return (
      <audio
        controls
        preload="none"
        src={media.url}
        aria-label={`Preview ${asset.file}`}
        className="w-full"
        onError={() => setFailed(true)}
      />
    );
  if (asset.kind === "video")
    return (
      <video
        controls
        preload="metadata"
        src={media.url}
        aria-label={`Preview ${asset.file}`}
        className="max-h-64 w-full rounded-md bg-black"
        onError={() => setFailed(true)}
      />
    );
  return (
    <img
      src={media.url}
      alt={asset.file}
      loading="lazy"
      className="max-h-64 w-full rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  );
}
