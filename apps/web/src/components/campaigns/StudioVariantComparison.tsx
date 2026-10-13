import type { EnvironmentId, StudioAsset } from "@t3tools/contracts";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { StudioAssetPreview } from "./StudioAssetPreview";

export function StudioVariantComparison({
  environmentId,
  assets,
  selectedAssetId,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly assets: readonly StudioAsset[];
  readonly selectedAssetId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const id = useId();
  const [leftId, setLeftId] = useState(selectedAssetId ?? assets[0]?.id ?? "");
  const [rightId, setRightId] = useState(assets.find((asset) => asset.id !== leftId)?.id ?? "");
  const left = assets.find((asset) => asset.id === leftId) ?? assets[0];
  const right =
    assets.find((asset) => asset.id === rightId && asset.id !== left?.id) ??
    assets.find((asset) => asset.id !== left?.id);
  if (assets.length < 2) return null;
  return (
    <details className="space-y-3">
      <summary className="text-sm font-medium">Compare variants side by side</summary>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            { side: "A", asset: left, set: setLeftId },
            { side: "B", asset: right, set: setRightId },
          ] as const
        ).map(
          ({ side, asset, set }) =>
            asset && (
              <div key={side} className="min-w-0 space-y-2 rounded-md border border-border p-2">
                <label htmlFor={`${id}-${side}`} className="text-xs">
                  Variant {side}
                </label>
                <select
                  id={`${id}-${side}`}
                  className="w-full rounded-md border border-input bg-background p-2 text-sm"
                  value={asset.id}
                  onChange={(event) => set(event.currentTarget.value)}
                >
                  {assets
                    .filter((candidate) => side === "A" || candidate.id !== left?.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.file}
                      </option>
                    ))}
                </select>
                <StudioAssetPreview key={asset.id} environmentId={environmentId} asset={asset} />
                <p className="text-xs text-muted-foreground">
                  {asset.connector || "Imported"} · {asset.model || asset.kind} ·{" "}
                  {asset.approved ? "Approved" : "Needs review"}
                </p>
                {asset.prompt && <p className="text-xs">{asset.prompt}</p>}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={selectedAssetId === asset.id}
                  onClick={() => onSelect(asset.id)}
                >
                  {selectedAssetId === asset.id ? "Selected" : `Use variant ${side}`}
                </Button>
              </div>
            ),
        )}
      </div>
    </details>
  );
}
