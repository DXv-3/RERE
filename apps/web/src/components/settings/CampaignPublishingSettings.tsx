import type {
  CampaignConnectionState,
  CampaignConnectorKind,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Redacted from "effect/Redacted";
import { useId, useState, type FormEvent } from "react";

import { campaignFailureMessage } from "../campaigns/campaigns.logic";
import { CampaignConfirmDialog } from "../campaigns/CampaignConfirmDialog";
import { useCampaignBoard, useCampaignCommand } from "../campaigns/useCampaigns";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { CampaignGenerationSettings } from "./CampaignGenerationSettings";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow } from "./settingsLayout";

const CONNECTOR_LABEL: Readonly<Record<CampaignConnectorKind, string>> = {
  export: "Export Folders",
  "marketing-engine": "Savage Digital Solutions Marketing Engine",
};

/**
 * Where approved campaign posts go, and the one switch that lets them go. Everything starts off:
 * with publishing off, approved posts wait on the board. The key is write-only; once saved it is
 * never shown again.
 */
export function CampaignPublishingSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { board, loading, error, refresh } = useCampaignBoard(environmentId, true, null);
  const connection = board?.connection ?? null;
  return (
    <FoldedSettingsSection
      id="campaign-publishing"
      title="Campaign Publishing"
      summary={
        connection === null
          ? null
          : `${connection.publishing === "on" ? "On" : "Off"} · ${CONNECTOR_LABEL[connection.connector]}`
      }
    >
      {connection === null ? (
        error !== null ? (
          <div className="px-4 py-3 text-xs text-destructive-foreground" role="alert">
            Could not load campaign publishing. {error}{" "}
            <Button size="sm" variant="outline" onClick={refresh}>
              Try Again
            </Button>
          </div>
        ) : (
          <p
            className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground"
            role="status"
          >
            {loading ? <Spinner size="sm" /> : null}
            Loading…
          </p>
        )
      ) : (
        <>
          <PublishingForm environmentId={environmentId} connection={connection} />
          {board === null ? null : (
            <CampaignGenerationSettings
              environmentId={environmentId}
              generation={board.generation}
              clients={board.clients}
            />
          )}
        </>
      )}
    </FoldedSettingsSection>
  );
}

/** Mounted once the server's state is known, so the fields start from what is saved. */
function PublishingForm({
  environmentId,
  connection,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: CampaignConnectionState;
}) {
  const ids = { url: useId(), key: useId(), folder: useId() };
  const run = useCampaignCommand(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [connector, setConnector] = useState<CampaignConnectorKind>(connection.connector);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [folder, setFolder] = useState(connection.exportDirectory);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);

  const dirty =
    connector !== connection.connector ||
    baseUrl.trim() !== connection.baseUrl ||
    folder.trim() !== connection.exportDirectory ||
    key !== "";
  const engine = connector === "marketing-engine";

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setTestResult(null);
    const outcome = await run({
      command: "connection.set",
      connection: {
        connector,
        baseUrl: baseUrl.trim(),
        exportDirectory: folder.trim(),
        ...(key === "" ? {} : { apiKey: Redacted.make(key.trim()) }),
      },
    });
    setSaving(false);
    if (!outcome.ok) {
      setSaveError(outcome.message);
      return;
    }
    // The key is on the server now; do not leave it sitting in the page.
    setKey("");
    setSaved(true);
  };

  const removeKey = async () => {
    setSaving(true);
    setSaveError(null);
    const outcome = await run({ command: "connection.set", connection: { apiKey: null } });
    setSaving(false);
    if (!outcome.ok) setSaveError(outcome.message);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const outcome = await run({ command: "connection.test", connector });
    setTesting(false);
    if (!outcome.ok) {
      setTestResult({ ok: false, text: outcome.message });
      return;
    }
    if (outcome.value.kind !== "connectionTest") return;
    const { result } = outcome.value;
    setTestResult(
      result.ok
        ? { ok: true, text: "The connection works." }
        : { ok: false, text: result.reason ?? "The connection did not work." },
    );
  };

  const setPublishing = async (next: "on" | "off") => {
    setSwitching(true);
    setSwitchError(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { campaignPublishing: next } },
    });
    if (result._tag === "Failure") {
      setSwitching(false);
      if (!isAtomCommandInterrupted(result)) {
        setSwitchError(campaignFailureMessage(squashAtomCommandFailure(result)));
      }
      return false;
    }
    // Saving the connection with nothing changed makes the server send the board again, which is
    // what carries the new switch position to every open board.
    await run({ command: "connection.set", connection: {} });
    setSwitching(false);
    return true;
  };

  return (
    <>
      <SettingsRow
        title="Publishing"
        description={
          connection.publishing === "on"
            ? "Approved posts are sent at their time, or right away when they have none."
            : "Publishing is switched off. Approved posts wait on the board until you turn it on."
        }
        control={
          <Switch
            aria-label="Publishing"
            checked={connection.publishing === "on"}
            disabled={switching}
            onCheckedChange={(checked) => {
              if (checked) {
                setSwitchError(null);
                setConfirmOn(true);
              } else void setPublishing("off");
            }}
          />
        }
      >
        {switchError && !confirmOn ? (
          <Alert variant="error" className="mt-3">
            <AlertDescription>{switchError}</AlertDescription>
          </Alert>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Publishing Service"
        description="Where approved posts go. Export Folders saves each one as a folder you post by hand. The Savage Digital Solutions Marketing Engine posts to the accounts it has connected."
        control={
          <Select
            value={connector}
            onValueChange={(value) => {
              setConnector(value as CampaignConnectorKind);
              setSaved(false);
              setTestResult(null);
            }}
          >
            <SelectTrigger size="sm" className="w-64" aria-label="Publishing service">
              <SelectValue>{CONNECTOR_LABEL[connector]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(CONNECTOR_LABEL) as CampaignConnectorKind[]).map((kind) => (
                <SelectItem hideIndicator key={kind} value={kind}>
                  {CONNECTOR_LABEL[kind]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Settings For This Service"
        description={
          engine
            ? "The address and key come from the person who runs the marketing engine."
            : "Posts made from a project's thread are saved in that project. This folder is used for posts that have no thread."
        }
      >
        <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => void save(event)}>
          {engine ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.url}>
                  Base Address
                </label>
                <Input
                  id={ids.url}
                  nativeInput
                  inputMode="url"
                  placeholder="https://"
                  autoComplete="off"
                  spellCheck={false}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" htmlFor={ids.key}>
                  Key
                </label>
                <Input
                  id={ids.key}
                  nativeInput
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={
                    connection.hasKey ? "Type a new key to replace the saved one" : "Paste the key"
                  }
                  value={key}
                  onChange={(event) => setKey(event.currentTarget.value)}
                />
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {connection.hasKey ? "A key is saved." : "No key is saved."}
                  {connection.hasKey ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost-muted"
                      disabled={saving}
                      onClick={() => void removeKey()}
                    >
                      Remove Saved Key
                    </Button>
                  ) : null}
                </p>
              </div>
            </>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium" htmlFor={ids.folder}>
              Export Folder
            </label>
            <Input
              id={ids.folder}
              nativeInput
              font="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="Optional, an absolute folder path"
              value={folder}
              onChange={(event) => setFolder(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" type="submit" disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" /> : null}
              Save Changes
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={testing || saving || dirty}
              onClick={() => void test()}
            >
              {testing ? <Spinner size="sm" /> : null}
              Test Connection
            </Button>
            {dirty ? (
              <span className="text-xs text-muted-foreground">Save before testing.</span>
            ) : saved ? (
              <span role="status" className="text-xs text-muted-foreground">
                Saved.
              </span>
            ) : null}
          </div>
          {saveError ? (
            <Alert variant="error">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}
          {testResult ? (
            <Alert variant={testResult.ok ? "success" : "error"}>
              <AlertDescription>
                {testResult.ok ? "Connected. " : "Not connected. "}
                {testResult.text}
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
      </SettingsRow>
      <CampaignConfirmDialog
        open={confirmOn}
        title="Start Publishing?"
        body={
          connection.connector === "export"
            ? "Approved posts will start being saved as folders, at their scheduled time or right away when they have none. Posts that are already approved and due will be saved as soon as you confirm."
            : "Posts will start going out. Approved posts are sent to their platforms at their scheduled time, or right away when they have none, and posts that are already approved and due will be sent as soon as you confirm. Sent posts cannot be taken back."
        }
        confirmLabel="Start Publishing"
        pending={switching}
        error={switchError}
        onCancel={() => setConfirmOn(false)}
        onConfirm={() => void setPublishing("on").then((done) => done && setConfirmOn(false))}
      />
    </>
  );
}
