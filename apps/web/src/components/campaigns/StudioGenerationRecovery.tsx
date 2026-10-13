import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { CampaignRun } from "./useCampaigns";

/** Reattaches a known receipt. It never submits another paid generation request. */
export function StudioGenerationRecovery({
  jobId,
  run,
  disabled,
}: {
  readonly jobId: string;
  readonly run: CampaignRun;
  readonly disabled: boolean;
}) {
  const id = useId();
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const recover = async () => {
    if (busy || disabled || !receipt.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await run({
        command: "generation.reconcile",
        jobId,
        providerJobId: receipt.trim(),
      });
      setMessage(result.ok ? "Polling resumed with the provider receipt." : result.message);
    } catch {
      setMessage("Could not confirm recovery. Refresh the job before retrying.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs">
        Submission is uncertain. Find the existing job receipt with the provider to resume polling
        without paying for another generation.
      </p>
      <Label htmlFor={id}>Provider job receipt</Label>
      <Input
        nativeInput
        id={id}
        value={receipt}
        maxLength={128}
        onChange={(event) => setReceipt(event.currentTarget.value)}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || busy || !receipt.trim()}
        onClick={() => void recover()}
      >
        Resume polling
      </Button>
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
