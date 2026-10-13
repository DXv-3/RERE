export type ConversationIdentityTone = "this-device" | "remote" | "offline";

export interface ConversationEnvironmentChip {
  readonly text: string;
  readonly title: string;
  readonly tone: ConversationIdentityTone;
}

/**
 * Which machine a conversation lives on. The remote case is the one that must read at a glance,
 * so it gets the strongest neutral treatment, and an unreachable machine says so.
 */
export function describeConversationEnvironment(input: {
  readonly label: string | null;
  readonly isPrimary: boolean;
  readonly connected: boolean;
}): ConversationEnvironmentChip {
  const label = input.label?.trim() || null;
  const name = label ?? (input.isPrimary ? "This Device" : "Unknown Machine");
  if (!input.connected) {
    return {
      text: `${name} · Offline`,
      title: `This conversation lives on ${name}, which is offline. Replies can't run there until it reconnects.`,
      tone: "offline",
    };
  }
  if (input.isPrimary) {
    return {
      text: label ? `${label} · This Device` : "This Device",
      title: `This conversation lives on ${name}, the machine you are using.`,
      tone: "this-device",
    };
  }
  return {
    text: name,
    title: `This conversation lives on ${name}, a different machine from this one.`,
    tone: "remote",
  };
}

export interface ConversationModelChip {
  readonly text: string;
  readonly title: string;
  /** True when the provider reports a different model answering than the one selected. */
  readonly mismatch: boolean;
}

/** Lowercase with every run of punctuation and spaces collapsed to one dash, so "Opus 5.5" is "opus-5-5". */
function modelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// What may follow a model's name without making it another model: a release date, "latest", a
// context-window tag such as "[1m]", or a version tag such as "v2".
const VARIANT_SUFFIX = /(-(\d{6,8}|latest|1m|v\d+))+$/;

/**
 * Whether two model names are the same model. A dated or vendor-prefixed form of a name counts as
 * the same, so "claude-opus-5-5" matches "claude-opus-5-5-20260601" and "anthropic/claude-opus-5-5".
 * A longer name that is a different model does not: "gpt-5" is not "gpt-5-mini".
 */
export function isSameModel(left: string, right: string): boolean {
  const a = modelKey(left).replace(VARIANT_SUFFIX, "");
  const b = modelKey(right).replace(VARIANT_SUFFIX, "");
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
}

/**
 * The model for the conversation. Shows the selection, unless the provider reported a different
 * model answering the latest run: a gateway in front of a provider can fail over to another model
 * without telling anyone, so the chip then says who actually answered.
 */
export function describeConversationModel(input: {
  readonly providerName: string | null;
  readonly modelName: string | null;
  /** The selected model's id, such as "claude-opus-5-5". */
  readonly modelSlug?: string | null;
  /** The model the provider reports as having answered the latest run. */
  readonly answeringModel?: string | null;
}): ConversationModelChip {
  const provider = input.providerName?.trim() || null;
  const model = input.modelName?.trim() || null;
  const slug = input.modelSlug?.trim() || null;
  const text = [provider, model].filter((part): part is string => part !== null).join(" · ");
  const label = text.length > 0 ? text : "No Model Selected";
  const answering = input.answeringModel?.trim() || null;
  const selected = [slug, model].filter((part): part is string => part !== null);
  if (
    answering !== null &&
    selected.length > 0 &&
    !selected.some((candidate) => isSameModel(candidate, answering))
  ) {
    return {
      text: `Answered By ${answering}`,
      title: `Selected model: ${label}. The provider reports that ${answering} answered the latest reply instead.`,
      mismatch: true,
    };
  }
  return { text: label, title: `Selected model: ${label}`, mismatch: false };
}
