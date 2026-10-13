import { CAMPAIGN_NAME_MAX, type Campaign } from "@t3tools/contracts";
import { useId, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
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
import { CampaignConfirmDialog } from "./CampaignConfirmDialog";
import type { CampaignRun } from "./useCampaigns";

/** Creates a campaign for a client, or renames one. A campaign can also be deleted from here. */
export function CampaignNameDialog({
  open,
  ...form
}: {
  readonly open: boolean;
  readonly clientId: string;
  readonly clientName: string;
  /** Absent creates a new campaign. */
  readonly campaign: Pick<Campaign, "id" | "name"> | undefined;
  readonly run: CampaignRun;
  readonly onClose: () => void;
  readonly onSaved: (campaign: Campaign) => void;
  readonly onDeleted: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && form.onClose()}>
      <DialogPopup>
        <NameForm {...form} />
      </DialogPopup>
    </Dialog>
  );
}

/** Mounted with the dialog, so every opening starts from the saved name. */
function NameForm({
  clientId,
  clientName,
  campaign,
  run,
  onClose,
  onSaved,
  onDeleted,
}: {
  readonly clientId: string;
  readonly clientName: string;
  readonly campaign: Pick<Campaign, "id" | "name"> | undefined;
  readonly run: CampaignRun;
  readonly onClose: () => void;
  readonly onSaved: (campaign: Campaign) => void;
  readonly onDeleted: (id: string) => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(campaign?.name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    setPending(true);
    setError(null);
    const outcome = await run({
      command: "campaign.upsert",
      campaign: {
        ...(campaign === undefined ? {} : { id: campaign.id }),
        clientId,
        name: name.trim(),
      },
    });
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    if (outcome.value.kind === "campaign") onSaved(outcome.value.campaign);
    onClose();
  };

  const remove = async () => {
    if (campaign === undefined) return;
    setPending(true);
    setError(null);
    const outcome = await run({ command: "campaign.delete", id: campaign.id });
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setConfirmDelete(false);
    onDeleted(campaign.id);
    onClose();
  };

  return (
    <>
      <form onSubmit={(event) => void submit(event)} className="contents">
        <DialogHeader>
          <DialogTitle>{campaign === undefined ? "New Campaign" : "Rename Campaign"}</DialogTitle>
          <DialogDescription>
            {campaign === undefined
              ? `A campaign groups the posts for one push, like a launch or a month. It starts with ${clientName}'s mode.`
              : `This campaign belongs to ${clientName}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              nativeInput
              autoFocus
              value={name}
              maxLength={CAMPAIGN_NAME_MAX}
              onChange={(event) => setName(event.currentTarget.value)}
              autoComplete="off"
            />
          </div>
          {error && !confirmDelete ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {campaign !== undefined ? (
            <Button
              type="button"
              variant="destructive-outline"
              className="sm:mr-auto"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete Campaign
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || name.trim() === ""}>
            {pending && !confirmDelete ? <Spinner size="sm" /> : null}
            {campaign === undefined ? "Create Campaign" : "Save Name"}
          </Button>
        </DialogFooter>
      </form>
      <CampaignConfirmDialog
        open={confirmDelete}
        title="Delete This Campaign?"
        body={`${campaign?.name ?? "This campaign"} and all of its posts are removed. This cannot be undone.`}
        confirmLabel="Delete Campaign"
        destructive
        pending={pending}
        error={error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
