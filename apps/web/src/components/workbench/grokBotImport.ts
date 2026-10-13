import * as Schema from "effect/Schema";
import { AgentRecoveryDraft, type AgentAvatar } from "@t3tools/contracts";
import { grokBotColors } from "@t3tools/shared/agentAvatar";
import { AGENT_COLORS, type AgentProfile } from "./workbenchPreferences";

export interface ImportedMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestampMs: number | null;
}
export interface ImportedAgentArchive {
  id: string;
  sourceId: string;
  name: string;
  importedAt: string;
  exportedAt: string;
  sourceSettings: Record<string, string | number | boolean | null>;
  messages: ImportedMessage[];
}
export interface GrokBotImport {
  agents: {
    profile: AgentProfile;
    archive: ImportedAgentArchive;
    recoveryDraft?: typeof AgentRecoveryDraft.Type;
  }[];
}
const isRecoveryDraft = Schema.is(AgentRecoveryDraft);
const colors = grokBotColors;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
export function parseGrokBotImport(value: unknown): GrokBotImport {
  const data = record(value);
  if (
    data.format !== "workbench-grok-bot-import" ||
    data.version !== 1 ||
    !Array.isArray(data.agents)
  )
    throw new Error("Choose a Workbench Grok Bot export (version 1).");
  if (data.agents.length > 250) throw new Error("Import up to 250 agents at a time.");
  const seen = new Set<string>();
  const agents: GrokBotImport["agents"] = [];
  for (const raw of data.agents) {
    const row = record(raw);
    const sourceId = text(row.sourceId, 160);
    const name = text(row.name, 80).trim();
    if (!sourceId || !name || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const id = `grok-bot:${sourceId}`;
    const instructions = text(row.description, 16000);
    const history = record(row.history);
    if (Array.isArray(history.messages) && history.messages.length > 5000)
      throw new Error(
        `The archive for ${name} exceeds 5,000 messages. Keep the original export; this import was not saved.`,
      );
    const messages: ImportedMessage[] = [];
    const messageIds = new Set<string>();
    for (const rawMessage of Array.isArray(history.messages)
      ? history.messages.slice(0, 5000)
      : []) {
      const m = record(rawMessage);
      const mid = text(m.id, 200);
      if (typeof m.text === "string" && m.text.length > 100000)
        throw new Error(
          `A message for ${name} exceeds the supported size. The original archive must be preserved before splitting this import.`,
        );
      const body = text(m.text, 100000);
      if (!mid || !body || messageIds.has(mid) || (m.role !== "user" && m.role !== "assistant"))
        continue;
      messageIds.add(mid);
      messages.push({
        id: mid,
        role: m.role,
        text: body,
        timestampMs:
          typeof m.timestampMs === "number" && Number.isFinite(m.timestampMs)
            ? m.timestampMs
            : null,
      });
    }
    const settings = record(row.sourceSettings);
    const sourceSettings: ImportedAgentArchive["sourceSettings"] = {};
    for (const key of [
      "notificationsEnabled",
      "notifyOnUpdatesEnabled",
      "isHiddenFromSidebar",
      "voiceId",
      "voiceSpeed",
      "voiceLanguage",
      "isGroup",
      "avatarColor",
      "avatarShape",
    ]) {
      const v = key.startsWith("avatar") ? row[key] : settings[key];
      if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || v === null)
        sourceSettings[key] = v;
      else if (typeof v === "string") sourceSettings[key] = v.slice(0, 200);
    }
    agents.push({
      ...(isRecoveryDraft(row.recoveryDraft) ? { recoveryDraft: row.recoveryDraft } : {}),
      profile: {
        id,
        name,
        description: instructions.replace(/\s+/g, " ").slice(0, 240),
        instructions,
        color:
          colors[text(row.avatarColor, 30)] ?? AGENT_COLORS[agents.length % AGENT_COLORS.length]!,
        avatar: {
          kind: "bot",
          shape: ([
            "circle",
            "squircle",
            "cloud",
            "hex",
            "teardrop",
            "wedge",
            "blob",
            "tablet",
            "pebble",
          ].includes(String(row.avatarShape))
            ? row.avatarShape
            : "squircle") as AgentAvatar["shape"],
          color: colors[text(row.avatarColor, 30)] ?? "#8054e6",
          icon: "bot",
          image: null,
        },
        pinned: row.pinned === true,
        projectKey: "",
        runtimeMode: "approval-required",
        modelSelection: null,
      },
      archive: {
        id,
        sourceId,
        name,
        importedAt: new Date().toISOString(),
        exportedAt: text(data.exportedAt, 80),
        sourceSettings,
        messages,
      },
    });
  }
  if (!agents.length) throw new Error("No valid agent profiles were found in this export.");
  return { agents };
}

export function mergeArchive(
  previous: ImportedAgentArchive | undefined,
  incoming: ImportedAgentArchive,
): ImportedAgentArchive {
  const messages = new Map((previous?.messages ?? []).map((m) => [m.id, m]));
  for (const m of incoming.messages) messages.set(m.id, m);
  return {
    ...incoming,
    messages: [...messages.values()].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0)),
  };
}

function openArchive(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("workbench-agent-history", 1);
    let blocked = false;
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore("agents", { keyPath: "id" }),
    );
    request.addEventListener("success", () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.addEventListener("versionchange", () => request.result.close());
      resolve(request.result);
    });
    request.addEventListener("error", () =>
      reject(new Error("This device could not open the agent history store.")),
    );
    request.addEventListener("blocked", () => {
      blocked = true;
      reject(new Error("Close older Workbench tabs, then retry the import."));
    });
  });
}
export async function readAgentArchive(id: string): Promise<ImportedAgentArchive | undefined> {
  const db = await openArchive();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("agents", "readonly").objectStore("agents").get(id);
      request.addEventListener("success", () =>
        resolve(request.result as ImportedAgentArchive | undefined),
      );
      request.addEventListener("error", () =>
        reject(new Error("Could not load this agent’s imported history.")),
      );
    });
  } finally {
    db.close();
  }
}
export async function saveAgentArchives(archives: ImportedAgentArchive[]): Promise<void> {
  const db = await openArchive();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("agents", "readwrite");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () =>
        reject(new Error("The import could not be saved. Check available disk space and retry.")),
      );
      transaction.addEventListener("abort", () =>
        reject(new Error("The import was interrupted. Existing history was preserved.")),
      );
      const store = transaction.objectStore("agents");
      for (const archive of archives) {
        const request = store.get(archive.id);
        request.addEventListener("success", () =>
          store.put(mergeArchive(request.result as ImportedAgentArchive | undefined, archive)),
        );
      }
    });
  } finally {
    db.close();
  }
}
