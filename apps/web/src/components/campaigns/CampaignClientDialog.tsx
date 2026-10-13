import {
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_NOTES_MAX,
  type CampaignApprovalMode,
  type CampaignClient,
} from "@t3tools/contracts";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { CampaignConfirmDialog } from "./CampaignConfirmDialog";
import {
  MODE_OPTIONS,
  formatDoNotSay,
  modeChangeConfirmation,
  modeLabel,
  parseDoNotSay,
  parseSpendCap,
} from "./campaigns.logic";
import type { CampaignRun } from "./useCampaigns";

/**
 * Creates or edits a client: the name, what agents should know about the brand, phrases they must
 * never write, the client's id in the publishing service, the default mode and a spend limit.
 * Administrators only; the server refuses anyone else.
 */
export function CampaignClientDialog({
  open,
  ...form
}: {
  readonly open: boolean;
  /** Absent creates a new client. */
  readonly client: CampaignClient | undefined;
  readonly run: CampaignRun;
  readonly onClose: () => void;
  readonly onSaved: (client: CampaignClient) => void;
  readonly onDeleted: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && form.onClose()}>
      <DialogPopup>
        <ClientForm {...form} />
      </DialogPopup>
    </Dialog>
  );
}

/** Mounted with the dialog, so every opening starts from the saved client. */
function ClientForm({
  client,
  run,
  onClose,
  onSaved,
  onDeleted,
}: {
  readonly client: CampaignClient | undefined;
  readonly run: CampaignRun;
  readonly onClose: () => void;
  readonly onSaved: (client: CampaignClient) => void;
  readonly onDeleted: (id: string) => void;
}) {
  const ids = { name: useId(), notes: useId(), say: useId(), service: useId(), cap: useId() };
  const [name, setName] = useState(client?.name ?? "");
  const [notes, setNotes] = useState(client?.brandNotes ?? "");
  const [doNotSay, setDoNotSay] = useState(formatDoNotSay(client?.doNotSay ?? []));
  const [serviceId, setServiceId] = useState(client?.publishingClientId ?? "");
  const [mode, setMode] = useState<CampaignApprovalMode>(client?.approvalMode ?? "ask-first");
  const [cap, setCap] = useState(
    client?.monthlySpendCapUsd === undefined ? "" : String(client.monthlySpendCapUsd),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMode, setConfirmMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const parsedCap = parseSpendCap(cap);
  const nameMissing = name.trim() === "";
  const modeNeedsConfirm =
    mode !== (client?.approvalMode ?? "ask-first") &&
    modeChangeConfirmation(mode, { kind: "client", name: name.trim() || "this client" }) !== null;

  const save = async () => {
    if (nameMissing || !parsedCap.ok) return;
    setPending(true);
    setError(null);
    const outcome = await run({
      command: "client.upsert",
      client: {
        ...(client === undefined ? {} : { id: client.id }),
        name: name.trim(),
        brandNotes: notes,
        doNotSay: parseDoNotSay(doNotSay),
        publishingClientId: serviceId.trim() === "" ? null : serviceId.trim(),
        approvalMode: mode,
        monthlySpendCapUsd: parsedCap.value,
      },
    });
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setConfirmMode(false);
    if (outcome.value.kind === "client") onSaved(outcome.value.client);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (modeNeedsConfirm) setConfirmMode(true);
    else void save();
  };

  const remove = async () => {
    if (client === undefined) return;
    setPending(true);
    setError(null);
    const outcome = await run({ command: "client.delete", id: client.id });
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setConfirmDelete(false);
    onDeleted(client.id);
    onClose();
  };

  const modeConfirmation = modeChangeConfirmation(mode, {
    kind: "client",
    name: name.trim() || "this client",
  });

  return (
    <>
      <form onSubmit={submit} className="contents">
        <DialogHeader>
          <DialogTitle>{client === undefined ? "New Client" : "Edit Client"}</DialogTitle>
          <DialogDescription>
            A client is a brand you make posts for. Agents read the notes and never write the
            phrases on the do-not-say list.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              nativeInput
              value={name}
              maxLength={CAMPAIGN_NAME_MAX}
              onChange={(event) => setName(event.currentTarget.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.notes}>Brand Notes</Label>
            <Textarea
              id={ids.notes}
              value={notes}
              maxLength={CAMPAIGN_NOTES_MAX}
              onChange={(event) => setNotes(event.currentTarget.value)}
              placeholder="Voice, audience, colours, things to mention"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.say}>Do Not Say</Label>
            <Textarea
              id={ids.say}
              value={doNotSay}
              onChange={(event) => setDoNotSay(event.currentTarget.value)}
              placeholder="One phrase per line"
            />
            <p className="text-xs text-muted-foreground">
              A post with one of these phrases in a caption cannot be submitted or approved.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.service}>Client ID In The Publishing Service</Label>
            <Input
              id={ids.service}
              nativeInput
              font="mono"
              value={serviceId}
              onChange={(event) => setServiceId(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty when posts are only saved as folders to post by hand.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Default Mode</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
              <SelectTrigger size="sm" aria-label="Default mode for this client">
                <SelectValue>{modeLabel(mode)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {MODE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.mode} value={option.mode}>
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              A campaign can set its own mode instead.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.cap}>Monthly Spend Limit In Dollars (Optional)</Label>
            <Input
              id={ids.cap}
              nativeInput
              inputMode="decimal"
              value={cap}
              onChange={(event) => setCap(event.currentTarget.value)}
              aria-invalid={!parsedCap.ok}
              autoComplete="off"
            />
            {!parsedCap.ok ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                Type a number like 50, or leave it empty for no limit.
              </p>
            ) : null}
          </div>
          {error && !confirmMode && !confirmDelete ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {client !== undefined ? (
            <Button
              type="button"
              variant="destructive-outline"
              className="sm:mr-auto"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete Client
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || nameMissing || !parsedCap.ok}>
            {pending && !confirmMode && !confirmDelete ? <Spinner size="sm" /> : null}
            {client === undefined ? "Create Client" : "Save Client"}
          </Button>
        </DialogFooter>
      </form>
      <CampaignConfirmDialog
        open={confirmMode && modeConfirmation !== null}
        title={modeConfirmation?.title ?? ""}
        body={modeConfirmation?.body ?? ""}
        confirmLabel={modeConfirmation?.confirmLabel ?? "Confirm"}
        pending={pending}
        error={error}
        onCancel={() => setConfirmMode(false)}
        onConfirm={() => void save()}
      />
      <CampaignConfirmDialog
        open={confirmDelete}
        title="Delete This Client?"
        body={`${client?.name ?? "This client"} and every campaign and post under it are removed. This cannot be undone.`}
        confirmLabel="Delete Client"
        destructive
        pending={pending}
        error={error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
