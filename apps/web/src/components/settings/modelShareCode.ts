import {
  MODEL_SHARE_ROUTE_PREFIX,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

/**
 * One copyable string that carries everything a recipient needs to use a shared model: the
 * address, the token and the model names. The owner's Copy button produces it; the recipient
 * pastes it into "Add a shared model". It is `codewrench-share:` followed by base64url JSON, a
 * single unbroken word that survives chat apps. Parsing is strict: anything missing, malformed or
 * unexpected is refused rather than guessed at.
 */
export const MODEL_SHARE_CODE_SCHEME = "codewrench-share:";
const CODE_VERSION = 1;
const MAX_TOKEN_LENGTH = 512;
const MAX_MODELS = 32;
const MAX_MODEL_LENGTH = 200;
// A model name is one line of printable text with no comma, so it is safe to show and to list.
// oxlint-disable-next-line no-control-regex
const MODEL_NAME_PATTERN = /^[^\x00-\x1F\x7F,]+$/;

export interface SharedModelAccess {
  /** `https://host/api/model-share`, with no trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
  readonly models: ReadonlyArray<string>;
}

export type ModelShareCodeError =
  | "empty"
  | "not_a_share_code"
  | "malformed"
  | "unsupported_version"
  | "invalid_address"
  | "invalid_token"
  | "invalid_models";

export type ModelShareCodeResult =
  | { readonly ok: true; readonly access: SharedModelAccess }
  | { readonly ok: false; readonly error: ModelShareCodeError };

/** Words for the person pasting. Never includes any part of the code. */
export function describeModelShareCodeError(error: ModelShareCodeError): string {
  switch (error) {
    case "empty":
      return "Paste the share code you were sent.";
    case "not_a_share_code":
      return "That is not a share code. It starts with codewrench-share:";
    case "malformed":
      return "That share code is damaged. Ask for it again, or copy the whole line.";
    case "unsupported_version":
      return "That share code is from a newer version of CodeWrench. Update the app and try again.";
    case "invalid_address":
      return "That share code does not point at a valid model address.";
    case "invalid_token":
      return "That share code has no usable access token.";
    case "invalid_models":
      return "That share code does not name any usable models.";
  }
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The base URL if it is a plain http(s) address at the share route; otherwise null. */
function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname.replace(/\/+$/, "") !== MODEL_SHARE_ROUTE_PREFIX) return null;
  return `${url.origin}${MODEL_SHARE_ROUTE_PREFIX}`;
}

function isValidToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    /^[\x21-\x7E]+$/.test(value)
  );
}

function readModels(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODELS) return null;
  const models: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const model = entry.trim();
    if (
      model.length === 0 ||
      model.length > MAX_MODEL_LENGTH ||
      !MODEL_NAME_PATTERN.test(model) ||
      models.includes(model)
    ) {
      return null;
    }
    models.push(model);
  }
  return models;
}

/** Throws if the access could not be parsed back, so a bad code is never handed out. */
export function formatModelShareCode(access: SharedModelAccess): string {
  const baseUrl = normalizeBaseUrl(access.baseUrl);
  const models = readModels(access.models);
  if (baseUrl === null || !isValidToken(access.token) || models === null) {
    throw new Error("This share cannot be written as a share code.");
  }
  return `${MODEL_SHARE_CODE_SCHEME}${toBase64Url(
    JSON.stringify({ v: CODE_VERSION, url: baseUrl, token: access.token, models }),
  )}`;
}

const CODE_PATTERN = /codewrench-share:[A-Za-z0-9_-]+/g;

/** The one share code in what was pasted: the whole text, or a single code inside a message. */
function findCode(input: string): string | null {
  const compact = input.replace(/\s+/g, "");
  if (/^codewrench-share:[A-Za-z0-9_-]+$/.test(compact)) return compact;
  const matches = input.match(CODE_PATTERN);
  return matches?.length === 1 ? (matches[0] ?? null) : null;
}

export function parseModelShareCode(input: string): ModelShareCodeResult {
  if (input.trim().length === 0) return { ok: false, error: "empty" };
  const code = findCode(input);
  if (code === null) return { ok: false, error: "not_a_share_code" };

  const json = fromBase64Url(code.slice(MODEL_SHARE_CODE_SCHEME.length));
  if (json === null) return { ok: false, error: "malformed" };
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "malformed" };
  }
  const fields = payload as Record<string, unknown>;
  if (fields.v !== CODE_VERSION) {
    return {
      ok: false,
      error:
        typeof fields.v === "number" && fields.v > CODE_VERSION
          ? "unsupported_version"
          : "malformed",
    };
  }
  if (Object.keys(fields).some((key) => !["v", "url", "token", "models"].includes(key))) {
    return { ok: false, error: "malformed" };
  }
  const baseUrl = normalizeBaseUrl(fields.url);
  if (baseUrl === null) return { ok: false, error: "invalid_address" };
  if (!isValidToken(fields.token)) return { ok: false, error: "invalid_token" };
  const models = readModels(fields.models);
  if (models === null) return { ok: false, error: "invalid_models" };
  return { ok: true, access: { baseUrl, token: fields.token, models } };
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * The provider instance the manual instructions describe: a Claude provider whose endpoint and
 * token are environment variables and whose models are the shared ones. The token is stored as a
 * sensitive value, so the server keeps it out of settings reads.
 */
export function buildSharedModelInstance(
  access: SharedModelAccess,
  displayName: string,
): ProviderInstanceConfig {
  return {
    driver: CLAUDE_DRIVER,
    enabled: true,
    displayName,
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: access.baseUrl, sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: access.token, sensitive: true },
    ],
    config: { customModels: [...access.models] },
  };
}

/** The id and name a shared model's provider gets, avoiding any id already in use. */
export function nameSharedModelInstance(
  access: SharedModelAccess,
  existingIds: ReadonlySet<string>,
): { readonly instanceId: string; readonly displayName: string } {
  const first = access.models[0] ?? "model";
  const slug =
    first
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || "model";
  const base = `${CLAUDE_DRIVER}_shared_${slug}`;
  let instanceId = base;
  for (let suffix = 2; existingIds.has(instanceId); suffix += 1) {
    instanceId = `${base}_${suffix}`;
  }
  return { instanceId, displayName: `Shared: ${first}` };
}
