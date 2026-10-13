import type { AgentImportInput, AgentImportReceipt } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";
import { Download, History } from "lucide-react";
import {
  parseGrokBotImport,
  readAgentArchive,
  saveAgentArchives,
  type GrokBotImport,
} from "./grokBotImport";
import { useWorkbenchPreferences } from "./workbenchPreferences";

export function GrokBotMigration({
  importToServer,
}: {
  importToServer?: (input: typeof AgentImportInput.Type) => Promise<typeof AgentImportReceipt.Type>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<GrokBotImport | null>(null);
  const pendingReceipt = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const choose = async () => {
    const nativePicker = window.desktopBridge?.pickAgentImportFile;
    if (!nativePicker) {
      input.current?.click();
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const text = await nativePicker();
      if (text !== null) {
        pendingReceipt.current = null;
        setPreview(parseGrokBotImport(JSON.parse(text)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this export.");
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      if (importToServer) {
        const receipt = await importToServer({
          receiptId: pendingReceipt.current ?? (pendingReceipt.current = randomUUID()),
          agents: preview.agents,
        });
        setMessage(
          `Imported ${receipt.added} new agents. Updated ${receipt.enriched} existing archives. Review recovery before resuming work.`,
        );
        setPreview(null);
        pendingReceipt.current = null;
        return;
      }
      await saveAgentArchives(preview.agents.map((a) => a.archive));
      const prefs = useWorkbenchPreferences.getState();
      let added = 0;
      for (const { profile } of preview.agents) {
        // Re-import enriches the archive without overwriting local edits/settings.
        if (prefs.agents.some((a) => a.id === profile.id)) continue;
        prefs.saveAgent(profile);
        added++;
      }
      setMessage(
        `Imported ${added} new agents. Cached history saved for ${preview.agents.length} agents.`,
      );
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-wb-import="">
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        aria-label="Grok Bot Export File"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setError("");
          setMessage("");
          try {
            if (file.size > 10 * 1024 * 1024)
              throw new Error("Choose an export smaller than 10 MB.");
            pendingReceipt.current = null;
            setPreview(parseGrokBotImport(JSON.parse(await file.text())));
          } catch (error) {
            setError(error instanceof Error ? error.message : "Could not read this export.");
          }
        }}
      />
      <button onClick={() => void choose()} disabled={busy}>
        <Download size={15} /> Import Grok Bot
      </button>
      {preview && (
        <div data-wb-import-preview="">
          <strong>{preview.agents.length} Agent Profiles</strong>
          <p>
            {preview.agents.reduce((n, a) => n + a.archive.messages.length, 0)} cached messages.
            Names, descriptions, pinned agents, and source preferences will be preserved.
          </p>
          <p>
            History is a local archive and may be incomplete. Hosted memory, routines, computer
            access, and connected accounts do not transfer. A personal workspace is created
            automatically. Review recovery requirements before continuing work.
          </p>
          <details>
            <summary>Review Agent Names</summary>
            <ul>
              {preview.agents.map((a) => (
                <li key={a.profile.id}>
                  {a.profile.name} · {a.archive.messages.length} messages
                </li>
              ))}
            </ul>
          </details>
          <div data-wb-actions="">
            <button data-wb-primary="" disabled={busy} onClick={() => void apply()}>
              {busy ? "Importing…" : "Import Agents And History"}
            </button>
            <button disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" data-wb-error="">
          {error}
        </p>
      )}
    </div>
  );
}
export function GrokBotHistory({
  agentId,
  serverArchive,
  initiallyExpanded = false,
}: {
  agentId: string;
  serverArchive?: import("@t3tools/contracts").AgentArchive | undefined;
  initiallyExpanded?: boolean;
}) {
  const [localArchive, setArchive] = useState<
    import("@t3tools/contracts").AgentArchive | undefined
  >();
  const archive = serverArchive ?? (localArchive?.id === agentId ? localArchive : undefined);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    let active = true;
    if (serverArchive) return;
    if (agentId.startsWith("grok-bot:"))
      void readAgentArchive(agentId)
        .then((a) => {
          if (active) setArchive(a);
        })
        .catch((e) => {
          if (active) setError(e instanceof Error ? e.message : "History unavailable.");
        });
    return () => {
      active = false;
    };
  }, [agentId, serverArchive]);
  if (!agentId.startsWith("grok-bot:")) return null;
  return (
    <section data-wb-imported-history="">
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <History size={16} /> Earlier Conversation In Grok Bot{" "}
        {archive ? `(${archive.messages.length})` : ""}
      </button>
      {error && <p role="alert">{error}</p>}
      {expanded && archive && (
        <>
          <p>
            Local cached history, exported {new Date(archive.exportedAt).toLocaleDateString()}. This
            may not include every message or attachment. It is not sent to a provider automatically.
          </p>
          <details>
            <summary>Import Details</summary>
            <dl>
              {Object.entries(archive.sourceSettings).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value ?? "Not set")}</dd>
                </div>
              ))}
            </dl>
          </details>
          {archive.messages.length > limit && (
            <button onClick={() => setLimit(limit + 30)}>Load Earlier Messages</button>
          )}
          {archive.messages.slice(-limit).map((m) => (
            <article key={m.id} data-role={m.role}>
              <header>
                <strong>{m.role === "user" ? "You" : archive.name}</strong>
                {m.timestampMs !== null && <time>{new Date(m.timestampMs).toLocaleString()}</time>}
              </header>
              <p>{m.text}</p>
            </article>
          ))}
          {!archive.messages.length && (
            <p>No messages for this agent were present in the local cache.</p>
          )}
        </>
      )}
    </section>
  );
}
