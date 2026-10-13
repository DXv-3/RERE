import type { EnvironmentId, ModelShareCreateResult, ModelShareSnapshot } from "@t3tools/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { cannotManageSharingMessage, describeModelShareFailure } from "./modelShareFailure";
import { modelShareInstructions, modelShareInviteNotice } from "./modelShareInstructions";
import {
  defaultModelShareMachineId,
  describeModelShareAddress,
  modelShareMachineOptionLabel,
} from "./modelShareMachines";
import { SettingsRow } from "./settingsLayout";
import { useModelShareApi } from "./useModelShareApi";
import { useModelShareMachines } from "./useModelShareMachines";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timestampFormatter.format(parsed);
}

/** A share just made, with the address it was made for: switching machines must not change it. */
interface CreatedShare {
  readonly result: ModelShareCreateResult;
  readonly origin: string | null;
}

/**
 * Lets the owner hand someone a model a machine serves without pairing them to it. The holder of
 * a share reaches the model from their own machine and nothing else there. The machine is any
 * one this app is connected to, so a model on an always-on server can be shared from a laptop.
 */
export function ModelSharesSettings() {
  const { machines, primaryEnvironmentId } = useModelShareMachines();
  const [chosenId, setChosenId] = useState<EnvironmentId | null>(null);
  const machine =
    machines.find((candidate) => candidate.environmentId === chosenId) ??
    machines.find(
      (candidate) =>
        candidate.environmentId === defaultModelShareMachineId(machines, primaryEnvironmentId),
    ) ??
    machines[0]!;
  const api = useModelShareApi(machine.environmentId, machine.isPrimary);
  const canManage = machine.canManage !== false;

  const [loaded, setLoaded] = useState<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: ModelShareSnapshot;
  } | null>(null);
  const snapshot = loaded?.environmentId === machine.environmentId ? loaded.snapshot : null;
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    readonly environmentId: EnvironmentId;
    readonly cause: unknown;
  } | null>(null);
  const errorMessage =
    failure?.environmentId === machine.environmentId
      ? describeModelShareFailure(failure.cause, machine)
      : "";
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // The list and any failure remember which machine they came from, so a slow answer from a
  // machine the owner has since left never shows against the one now chosen.
  const environmentId = machine.environmentId;
  const reload = useCallback(
    () =>
      api.list().then(
        (next) => {
          setLoaded({ environmentId, snapshot: next });
          setFailure(null);
        },
        (cause: unknown) => setFailure({ environmentId, cause }),
      ),
    [api, environmentId],
  );
  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  const providers = snapshot?.providers ?? [];
  const shares = snapshot?.shares ?? [];
  const provider =
    providers.find((candidate) => candidate.providerInstanceId === providerId) ?? providers[0];

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setFailure({ environmentId, cause });
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const recipientEmail = email.trim();
    // A name is optional when there is an email: the email names the share.
    const name = label.trim() || recipientEmail;
    if (!provider || name.length === 0) return;
    void run(async () => {
      setShowCode(false);
      const result = await api.create({
        label: name,
        providerInstanceId: provider.providerInstanceId,
        ...(recipientEmail.length > 0 ? { recipientEmail } : {}),
      });
      setCreated({ result, origin: machine.origin });
      setEmail("");
      setLabel("");
    });
  };

  // Without an address other people can reach, there is no code worth copying or sending.
  const origin = created?.origin ?? null;
  const createdShare = created?.result ?? null;
  const instructions = createdShare
    ? modelShareInstructions({ created: createdShare, origin })
    : "";

  return (
    <FoldedSettingsSection
      id="shared-models"
      title="Shared models"
      summary={
        snapshot === null
          ? null
          : (machines.length > 1 ? `${machine.label}: ` : "") +
            (shares.length === 0
              ? "Not shared with anyone"
              : `Shared with ${shares.length === 1 ? "1 person" : `${shares.length} people`}`)
      }
    >
      {machines.length > 1 ? (
        <SettingsRow
          title="Machine"
          description={describeModelShareAddress(machine)}
          control={
            <Select
              value={machine.environmentId}
              onValueChange={(value) => {
                const next = machines.find((candidate) => candidate.environmentId === value);
                if (next) setChosenId(next.environmentId);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label="Machine to share from"
                disabled={busy}
              >
                <SelectValue>{machine.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {machines.map((candidate) => (
                  <SelectItem
                    hideIndicator
                    key={candidate.environmentId}
                    value={candidate.environmentId}
                  >
                    {modelShareMachineOptionLabel(candidate)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}

      {canManage ? null : (
        <SettingsRow title="Share a model">
          <Alert variant="warning" className="mt-3">
            <AlertDescription>{cannotManageSharingMessage(machine)}</AlertDescription>
          </Alert>
        </SettingsRow>
      )}

      {canManage ? (
        <SettingsRow
          title="Share a model"
          description={
            provider
              ? "Type their email and the model appears in their CodeWrench when they sign in. Or leave the email empty and send them a share code. Either way they use it from their own CodeWrench and cannot open this environment, read its threads, or run anything on it."
              : "No provider here can be shared. Sharing works for a Claude provider that points at your own model endpoint, not one signed in to Anthropic."
          }
        >
          {provider ? (
            <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={handleCreate}>
              <Input
                aria-label="Email of the person to share with"
                autoCapitalize="none"
                autoComplete="off"
                className="w-full sm:w-64"
                disabled={busy}
                nativeInput
                onChange={(event) => setEmail(event.currentTarget.value)}
                placeholder="Their email"
                spellCheck={false}
                type="email"
                value={email}
              />
              <Input
                aria-label="Who the share is for"
                className="w-full sm:w-48"
                disabled={busy}
                nativeInput
                onChange={(event) => setLabel(event.currentTarget.value)}
                placeholder={email.trim().length > 0 ? "Name (optional)" : "Who is it for?"}
                value={label}
              />
              {providers.length > 1 ? (
                <Select
                  value={provider.providerInstanceId}
                  onValueChange={(value) => {
                    if (typeof value === "string") setProviderId(value);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full sm:w-56"
                    aria-label="Provider to share"
                  >
                    <SelectValue>{provider.displayName}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {providers.map((candidate) => (
                      <SelectItem
                        hideIndicator
                        key={candidate.providerInstanceId}
                        value={candidate.providerInstanceId}
                      >
                        {candidate.displayName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {provider.displayName}: {provider.models.join(", ")}
                </span>
              )}
              <Button
                disabled={busy || (label.trim().length === 0 && email.trim().length === 0)}
                size="sm"
                type="submit"
              >
                {email.trim().length > 0 ? "Share" : "Create Share"}
              </Button>
            </form>
          ) : null}

          {errorMessage ? (
            <Alert variant="error" className="mt-3">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          {createdShare ? (
            createdShare.share.recipientEmail ? (
              <div className="mt-3 rounded-lg border border-border/70 bg-background/55 px-3 py-3">
                <p className="text-xs font-medium" role="status">
                  {modelShareInviteNotice({
                    recipientEmail: createdShare.share.recipientEmail,
                    emailed: createdShare.emailed,
                  })}
                </p>
                {showCode ? (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Send this to {createdShare.share.label}. The token is shown only this once.
                    </p>
                    <pre className="mt-2 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
                      {instructions}
                    </pre>
                  </>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {origin === null ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        copyToClipboard(instructions, undefined);
                        setShowCode(true);
                      }}
                    >
                      {isCopied ? "Copied" : "Copy Share Code Instead"}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setCreated(null)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-border/70 bg-background/55 px-3 py-3">
                <p className="text-xs font-medium" role={origin === null ? "alert" : undefined}>
                  {origin === null
                    ? `Nothing To Send ${createdShare.share.label} Yet`
                    : `Send this to ${createdShare.share.label}. The token is shown only this once.`}
                </p>
                <pre className="mt-2 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
                  {instructions}
                </pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  {origin === null ? null : (
                    <Button size="sm" onClick={() => copyToClipboard(instructions, undefined)}>
                      {isCopied ? "Copied" : "Copy"}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => setCreated(null)}>
                    Done
                  </Button>
                </div>
              </div>
            )
          ) : null}
        </SettingsRow>
      ) : null}

      {shares.map((share) => (
        <SettingsRow
          key={share.id}
          title={share.label}
          description={[
            share.models.join(", "),
            ...(share.recipientEmail
              ? [
                  `shared with ${share.recipientEmail}`,
                  share.inviteAcceptedAt
                    ? `in their CodeWrench since ${formatTimestamp(share.inviteAcceptedAt)}`
                    : "waiting for them to sign in",
                ]
              : []),
            `created ${formatTimestamp(share.createdAt)}`,
            share.lastUsedAt ? `last used ${formatTimestamp(share.lastUsedAt)}` : "never used",
          ].join(" · ")}
          control={
            <Button
              disabled={busy}
              size="sm"
              variant="outline"
              onClick={() =>
                void run(async () => {
                  await api.revoke(share.id);
                  if (createdShare?.share.id === share.id) setCreated(null);
                })
              }
            >
              Revoke
            </Button>
          }
        />
      ))}
    </FoldedSettingsSection>
  );
}
