import type { CampaignStorageState, EnvironmentId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useId, useState, type FormEvent } from "react";

import { CampaignConfirmDialog } from "../campaigns/CampaignConfirmDialog";
import { useCampaignBoard, useCampaignCommand } from "../campaigns/useCampaigns";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow } from "./settingsLayout";

/**
 * Where campaign files get a public link, so a publishing service can fetch them: a bucket the
 * owner has, or this server itself at its own public address. Off until the owner turns it on. The
 * two bucket keys are write-only: once saved they are never shown again.
 */

type StorageKind = "s3" | "server";

/** This page's own address when it is a public https one, which is the best guess for the server's. */
function suggestedServerAddress(): string {
  if (typeof window === "undefined") return "";
  const { protocol, hostname, origin } = window.location;
  const local =
    hostname === "localhost" || hostname.endsWith(".local") || /^[\d.]+$/.test(hostname);
  return protocol === "https:" && !local ? origin : "";
}
export function CampaignStorageSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { board, loading, error, refresh } = useCampaignBoard(environmentId, true, null);
  const storage = board?.storage ?? null;
  return (
    <FoldedSettingsSection
      id="campaign-storage"
      title="Campaign Cloud Storage"
      summary={
        storage === null
          ? null
          : storage.mode === "off"
            ? "Off"
            : storage.mode === "server"
              ? "On, This Server"
              : "On"
      }
    >
      {storage === null ? (
        error !== null ? (
          <div className="px-4 py-3 text-xs text-destructive-foreground" role="alert">
            Could not load cloud storage. {error}{" "}
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
        <StorageForm environmentId={environmentId} storage={storage} />
      )}
    </FoldedSettingsSection>
  );
}

function StorageForm({
  environmentId,
  storage,
}: {
  readonly environmentId: EnvironmentId;
  readonly storage: CampaignStorageState;
}) {
  const ids = {
    endpoint: useId(),
    bucket: useId(),
    region: useId(),
    publicUrl: useId(),
    prefix: useId(),
    accessKey: useId(),
    secretKey: useId(),
  };
  const run = useCampaignCommand(environmentId);
  const [endpoint, setEndpoint] = useState(storage.endpoint);
  const [bucket, setBucket] = useState(storage.bucket);
  const [region, setRegion] = useState(storage.region);
  const [publicUrl, setPublicUrl] = useState(storage.publicBaseUrl);
  const [prefix, setPrefix] = useState(storage.prefix);
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [kind, setKind] = useState<StorageKind>(storage.mode === "server" ? "server" : "s3");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);

  const suggestion = suggestedServerAddress();
  const on = storage.mode !== "off";
  const dirty =
    publicUrl.trim() !== storage.publicBaseUrl ||
    (kind === "s3" &&
      (endpoint.trim() !== storage.endpoint ||
        bucket.trim() !== storage.bucket ||
        region.trim() !== storage.region ||
        prefix.trim() !== storage.prefix ||
        accessKey !== "" ||
        secretKey !== ""));

  const chooseKind = (value: StorageKind) => {
    setKind(value);
    setTestResult(null);
    // The address of this very page is the likeliest answer, but the owner still confirms it.
    if (value === "server" && publicUrl.trim() === "" && suggestion !== "")
      setPublicUrl(suggestion);
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setTestResult(null);
    const outcome = await run({
      command: "storage.set",
      storage:
        kind === "server"
          ? { publicBaseUrl: publicUrl.trim() }
          : {
              endpoint: endpoint.trim(),
              bucket: bucket.trim(),
              region: region.trim(),
              publicBaseUrl: publicUrl.trim(),
              prefix: prefix.trim(),
              ...(accessKey === "" ? {} : { accessKeyId: Redacted.make(accessKey.trim()) }),
              ...(secretKey === "" ? {} : { secretAccessKey: Redacted.make(secretKey.trim()) }),
            },
    });
    setSaving(false);
    if (!outcome.ok) {
      setSaveError(outcome.message);
      return;
    }
    // The keys are on the server now; do not leave them sitting in the page.
    setAccessKey("");
    setSecretKey("");
    setSaved(true);
  };

  const removeKeys = async () => {
    setSaving(true);
    setSaveError(null);
    const outcome = await run({
      command: "storage.set",
      storage: { mode: "off", accessKeyId: null, secretAccessKey: null },
    });
    setSaving(false);
    if (!outcome.ok) setSaveError(outcome.message);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const outcome = await run({ command: "storage.test" });
    setTesting(false);
    if (!outcome.ok) {
      setTestResult({ ok: false, text: outcome.message });
      return;
    }
    if (outcome.value.kind !== "storageTest") return;
    const { result } = outcome.value;
    setTestResult(
      result.ok
        ? {
            ok: true,
            text:
              result.reason ??
              (kind === "server"
                ? "This server fetched a test file from its own public address."
                : "A test file was uploaded, opened and deleted."),
          }
        : { ok: false, text: result.reason ?? "The test did not work." },
    );
  };

  const setMode = async (mode: "on" | "off") => {
    setSwitching(true);
    setSwitchError(null);
    const outcome = await run({
      command: "storage.set",
      storage: { mode: mode === "on" ? kind : "off" },
    });
    setSwitching(false);
    if (!outcome.ok) {
      setSwitchError(outcome.message);
      return false;
    }
    return true;
  };

  return (
    <>
      <SettingsRow
        title="Public File Links"
        description={
          storage.mode === "s3"
            ? "Files from a post are uploaded here when it is about to be published, or when you ask for public links. Anyone with a file's link can open it."
            : storage.mode === "server"
              ? "Files from a post are served from this computer when it is about to be published, or when you ask for public links. Anyone with a file's link can open it until you stop sharing."
              : "Public links are off. Nothing is uploaded or shared, and posts with files from a folder cannot go to the marketing engine until you add links or turn this on."
        }
        control={
          <Switch
            aria-label="Public file links"
            checked={on}
            disabled={switching}
            onCheckedChange={(checked) => {
              if (checked) {
                setSwitchError(null);
                setConfirmOn(true);
              } else void setMode("off");
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
        title="Where Files Are Kept"
        description={
          on
            ? "Turn public links off to change this."
            : "Use a bucket you own, or let this server hand the files out itself."
        }
      >
        <RadioGroup
          aria-label="Where files are kept"
          className="mt-3 sm:flex-row"
          value={kind}
          disabled={on}
          onValueChange={(value) => chooseKind(value === "server" ? "server" : "s3")}
        >
          {(
            [
              ["s3", "Cloud Storage"],
              ["server", "This Server"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <Radio value={value} />
              <span className="font-medium">{label}</span>
            </label>
          ))}
        </RadioGroup>
      </SettingsRow>
      <SettingsRow
        title={kind === "server" ? "Server Address" : "Storage Details"}
        description={
          kind === "server"
            ? "Files are served from this computer at the address below. Anyone with a file's link can open it until you stop sharing."
            : "Any S3-compatible service works, including Cloudflare R2. Use a bucket meant for public files: everything uploaded there can be opened by anyone who has the link."
        }
      >
        <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => void save(event)}>
          {kind === "s3" ? (
            <>
              <Field id={ids.endpoint} label="Storage Address">
                <Input
                  id={ids.endpoint}
                  nativeInput
                  inputMode="url"
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                  autoComplete="off"
                  spellCheck={false}
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.currentTarget.value)}
                />
              </Field>
              <Field id={ids.bucket} label="Bucket">
                <Input
                  id={ids.bucket}
                  nativeInput
                  autoComplete="off"
                  spellCheck={false}
                  value={bucket}
                  onChange={(event) => setBucket(event.currentTarget.value)}
                />
              </Field>
            </>
          ) : null}
          <Field id={ids.publicUrl} label="Public Address">
            <Input
              id={ids.publicUrl}
              nativeInput
              inputMode="url"
              placeholder={
                kind === "server" ? "https://code.example.com" : "https://files.example.com"
              }
              autoComplete="off"
              spellCheck={false}
              value={publicUrl}
              onChange={(event) => setPublicUrl(event.currentTarget.value)}
            />
          </Field>
          {kind === "server" ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Use the https address people reach this server at from the internet.
              {suggestion !== "" && publicUrl.trim() !== suggestion ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  onClick={() => setPublicUrl(suggestion)}
                >
                  Use {suggestion}
                </Button>
              ) : null}
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={ids.region} label="Region">
                  <Input
                    id={ids.region}
                    nativeInput
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="auto"
                    value={region}
                    onChange={(event) => setRegion(event.currentTarget.value)}
                  />
                </Field>
                <Field id={ids.prefix} label="Folder Prefix">
                  <Input
                    id={ids.prefix}
                    nativeInput
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="campaigns/"
                    value={prefix}
                    onChange={(event) => setPrefix(event.currentTarget.value)}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={ids.accessKey} label="Access Key ID">
                  <Input
                    id={ids.accessKey}
                    nativeInput
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={
                      storage.hasCredentials ? "Type a new one to replace it" : "Paste it"
                    }
                    value={accessKey}
                    onChange={(event) => setAccessKey(event.currentTarget.value)}
                  />
                </Field>
                <Field id={ids.secretKey} label="Secret Access Key">
                  <Input
                    id={ids.secretKey}
                    nativeInput
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={
                      storage.hasCredentials ? "Type a new one to replace it" : "Paste it"
                    }
                    value={secretKey}
                    onChange={(event) => setSecretKey(event.currentTarget.value)}
                  />
                </Field>
              </div>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {storage.hasCredentials ? "Keys are saved." : "No keys are saved."}
                {storage.hasCredentials ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost-muted"
                    disabled={saving}
                    onClick={() => void removeKeys()}
                  >
                    Remove Saved Keys And Turn Off
                  </Button>
                ) : null}
              </p>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" type="submit" disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" /> : null}
              Save Changes
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={
                testing || saving || dirty || (kind === "server" && storage.mode !== "server")
              }
              onClick={() => void test()}
            >
              {testing ? <Spinner size="sm" /> : null}
              Test Storage
            </Button>
            {dirty ? (
              <span className="text-xs text-muted-foreground">Save before testing.</span>
            ) : kind === "server" && storage.mode !== "server" ? (
              <span className="text-xs text-muted-foreground">
                Turn on public links first. The test needs them on.
              </span>
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
                {testResult.ok ? "It works. " : "It did not work. "}
                {testResult.text}
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
      </SettingsRow>
      <CampaignConfirmDialog
        open={confirmOn}
        title={kind === "server" ? "Turn On Sharing From This Server?" : "Turn On Cloud Storage?"}
        body={
          kind === "server"
            ? "Files from campaign posts will be served from this computer, at the address you saved, when a post is about to be published, or when you ask for public links. Anyone who has a file's link can open it until you stop sharing. Only pictures, video and audio from a post's thread folder are ever shared."
            : "Files from campaign posts will be uploaded to your storage when a post is about to be published, or when you ask for public links. Anyone who has a file's link can open it. Only turn this on for a bucket meant for public files."
        }
        confirmLabel="Turn On"
        pending={switching}
        error={switchError}
        onCancel={() => setConfirmOn(false)}
        onConfirm={() => void setMode("on").then((done) => done && setConfirmOn(false))}
      />
    </>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}
