import type {
  JevAdvice,
  ModelSelection,
  RoutingDecision,
  RoutingLadder,
  RoutingPreference,
  ServerProvider,
} from "@t3tools/contracts";

type Capability = JevAdvice["capability"];
type Effort = JevAdvice["effort"];

export interface SelectionAdvice {
  readonly judge: RoutingDecision["judge"];
  readonly capability: Capability;
  readonly effort: Effort;
  readonly capabilityConfidence: number;
  readonly effortConfidence: number;
}
export interface WeeklyPace {
  readonly usedPercent: number;
  readonly elapsedPercent: number;
}

/** Below this the router keeps whatever the message arrived with. */
const MIN_CONFIDENCE = 0.6;
// Points of weekly allowance used beyond the share of the week that has passed.
const AHEAD = 10;
const WELL_AHEAD = 25;

const EFFORT_OPTION_IDS = ["effort", "reasoningEffort"];
const CAPABILITIES = ["basic", "standard", "advanced"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
/** Every effort a provider may offer, lowest first; the judge only ever names the middle three. */
const EFFORT_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const FOLLOW_UP =
  /^(continue|go on|go ahead|proceed|keep going|yes|yep|yeah|ok|okay|sure|do it|next|please do|sounds good|thanks|thank you)\b[\s.!]*$/i;
const ADVANCED =
  /\b(plan|architect\w*|design|refactor\w*|review|audit|debug\w*|investigat\w*|migrat\w*|root cause|security|race condition|deadlock|performance)\b/i;
const WORK =
  /\b(implement\w*|fix\w*|build|write|create|add|update|change|remove|delete|deploy|test\w*|install|run|merge|commit|rewrite|convert|generate)\b|[`/\\]|\.\w{2,4}\b/i;
const QUESTION =
  /^(what|whats|what's|where|which|who|when|why|how|is|are|can|does|do|did|show|list|explain|summari[sz]e|define|tell me)\b|\?\s*$/i;

// Writing for a reader: a writing verb, a few words, then something a person will read. Code
// words between the two, or right after the noun, mean the text is about software instead
// ("write a test for the email", "fix the email validation regex", "update the page component").
const WORD = "[\\p{L}\\p{N}_'\u2019-]";
const WRITING_VERB =
  "(?:writ(?:e|ing)|rewrit(?:e|ing)|draft(?:ing)?|edit(?:ing)?|improv(?:e|ing)|updat(?:e|ing)|redo|creat(?:e|ing)|mak(?:e|ing)|fix(?:ing)?|tailor(?:ing)?|polish(?:ing)?|proofread(?:ing)?)";
const READER_NOUN =
  "(?:landing\\s+pages?|home\\s?pages?|web\\s?pages?|about\\s+pages?|docs\\s+pages?|download\\s+pages?|pages?|website\\s+copy|copy|content|wording|headlines?|r[e\u00e9]sum[e\u00e9]s?|cvs?|cover\\s+letters?|job\\s+applications?|application\\s+answers?|portfolios?|bios?|e-?mails?|newsletters?|messages?\\s+to\\s+(?:an?\\s+|the\\s+|my\\s+|our\\s+)?(?:clients?|customers?)|proposals?|reports?|articles?|blog\\s+posts?|posts?|help\\s+articles?|case\\s+stud(?:y|ies)|press\\s+releases?|announcements?|faqs?|pitch(?:es)?|(?:product|meta)\\s+descriptions?)";
const CODE_WORDS = new Set(
  (
    "function functions test tests spec component components endpoint endpoints regex validation " +
    "validator schema migration header headers props prop hook hooks class script scripts query " +
    "queries api route routes type types variable variables file files folder branch handler " +
    "request requests field fields column table module config commit bug error layout css style " +
    "styles styling crash"
  ).split(" "),
);
/** Words that end the stretch just after the noun where a code word would make it a code task. */
const AFTER_STOP = /^(?:about|for|to|on|of|in|with|that|and|or|which|from|so|by|at|the|a|an)$/;
const WRITING_PHRASE = new RegExp(
  `(?<!${WORD})${WRITING_VERB}(?!${WORD})((?:\\s+${WORD}+){0,4}?)\\s+${READER_NOUN}(?!${WORD})(?=((?:\\s+${WORD}+){0,2}))`,
  "giu",
);
const COPY_OF = /\b(?:make|create|made)\s+(?:a|an|another|the|one)\s+copy\b/gi;
const isCodeWord = (word: string) => CODE_WORDS.has(word.toLowerCase().replace(/['\u2019]s$/, ""));

/** True when the task asks for prose a person will read: a page, a résumé, an email, a report. */
export function isWritingTask(task: string): boolean {
  for (const sentence of task.replace(COPY_OF, " ").split(/[.!?;\n]+/)) {
    for (const match of sentence.matchAll(WRITING_PHRASE)) {
      const between = (match[1] ?? "").trim().split(/\s+/);
      if (between.some(isCodeWord)) continue;
      let code = false;
      for (const word of (match[2] ?? "").trim().split(/\s+/)) {
        if (!word || AFTER_STOP.test(word.toLowerCase())) break;
        if (isCodeWord(word)) {
          code = true;
          break;
        }
      }
      if (!code) return true;
    }
  }
  return false;
}

/** A short acknowledgement carries no task of its own; reuse the thread's last judgment. */
export const isFollowUp = (task: string) => task.length <= 40 && FOLLOW_UP.test(task.trim());

/**
 * In a running thread the model is already fixed, so the judge is asked only for skills, and a
 * message this short is a reply to the conversation ("try now", "i ran it"), not a task a skill
 * could be matched to. Of 79 such messages sent to Jev, it called 74 "not a task".
 */
export const isBareReply = (task: string) => task.trim().length <= 40;

const advice = (capability: Capability, effort: Effort, confidence: number): SelectionAdvice => ({
  judge: "local",
  capability,
  effort,
  capabilityConfidence: confidence,
  effortConfidence: confidence,
});

/** Rules that need no network call. Only clear signals move a model. */
export function localAdvice(task: string, attachmentCount: number): SelectionAdvice {
  const text = task.trim();
  if (ADVANCED.test(text) || text.length > 1_500 || attachmentCount >= 3)
    return advice("advanced", "high", 0.7);
  // A short plain question that asks for no work is the clearest case there is.
  if (
    text.length <= 200 &&
    attachmentCount === 0 &&
    QUESTION.test(text) &&
    !WORK.test(text) &&
    !isWritingTask(text)
  )
    return advice("basic", "low", 0.85);
  return advice("standard", "medium", 0.5);
}

/**
 * Jev's view where it is sure, and nothing where it is not. Keyword rules do not fill the gap:
 * they are the fallback for when Jev cannot be asked, and a word like "plan" or "design" in a
 * message Jev found unclear is no reason to move a model.
 */
export function mergeAdvice(jev: JevAdvice): SelectionAdvice {
  // Text that is no task of its own says nothing about effort either.
  const task = jev.capability !== "unknown";
  return {
    judge: "jev",
    capability: jev.capability,
    effort: task ? jev.effort : "unknown",
    capabilityConfidence: jev.confidence.capability,
    effortConfidence: task ? jev.confidence.effort : 0,
  };
}

// Whole name parts only: "gemini" must not read as "mini".
const BASIC_NAME = /(^|[^a-z])(haiku|mini|nano|flash|fast|lite|air|small)([^a-z]|$)/i;
const ADVANCED_NAME = /(^|[^a-z])(opus|pro|max|ultra)([^a-z]|$)/i;

/** A model's list price per token, or null when it is not known. Used only to order models. */
export type PriceOf = (model: string) => number | null;

/**
 * Three rungs from prices alone, for a family whose names say nothing about size (Luna, Sol,
 * Astra): the cheapest model is the small one, the dearest the large one, and the middle is the
 * account's default when it sits between them, otherwise the middle price. Needs two price
 * levels; one level is no ladder at all.
 */
function pricedLadder(
  models: ReadonlyArray<ServerProvider["models"][number]>,
  priceOf: PriceOf,
): RoutingLadder {
  const priced = models.flatMap((model) => {
    const price = priceOf(model.slug);
    return price === null ? [] : [{ model, price }];
  });
  const levels = [...new Set(priced.map((item) => item.price))].sort((a, b) => a - b);
  if (levels.length < 2) return {};
  // Providers list their newest models first, so the first at a price is the one to use.
  const at = (price: number) => priced.find((item) => item.price === price)!.model;
  const low = at(levels[0]!);
  const high = at(levels.at(-1)!);
  const preferred = priced.find((item) => item.model.isDefault);
  if (levels.length === 2)
    return preferred?.model.slug === low.slug
      ? { standard: low.slug, advanced: high.slug }
      : { basic: low.slug, standard: high.slug };
  const between = levels.slice(1, -1);
  const middle =
    preferred && between.includes(preferred.price)
      ? preferred.model
      : at(between[Math.floor((between.length - 1) / 2)]!);
  return { basic: low.slug, standard: middle.slug, advanced: high.slug };
}

/**
 * The ladder is worked out, not set by hand. Tiers are read from the names every provider family
 * uses (haiku, mini, flash for small; opus, pro, max for large), with the account's default
 * model as the middle. Where the names say nothing, prices order the models instead. A rung the
 * person chose in settings replaces the worked-out one; the rest stay automatic. A tier with no
 * clear model stays empty and the router adapts effort only for it.
 */
export function resolveLadder(
  provider: ServerProvider,
  configured: RoutingLadder | undefined,
  priceOf: PriceOf = () => null,
): RoutingLadder {
  const models = provider.models.filter((model) => !model.isCustom);
  const current = models.filter((model) => !model.isLegacy);
  const named = (pattern: RegExp) =>
    (
      current.find((model) => pattern.test(model.slug)) ??
      models.find((model) => pattern.test(model.slug))
    )?.slug;
  const claude = provider.driver.toLowerCase().includes("claude");
  const basic = named(claude ? /haiku/i : BASIC_NAME);
  const advanced = named(claude ? /opus/i : ADVANCED_NAME);
  const standard =
    (claude ? named(/sonnet/i) : undefined) ??
    current.find((model) => model.isDefault && model.slug !== basic && model.slug !== advanced)
      ?.slug;
  const byName = {
    ...(basic ? { basic } : {}),
    ...(standard ? { standard } : {}),
    ...(advanced ? { advanced } : {}),
  };
  const byPrice = basic || advanced ? {} : pricedLadder(current.length ? current : models, priceOf);
  return { ...(Object.keys(byPrice).length > 0 ? byPrice : byName), ...configured };
}

/** Weekly usage against the calendar, when the account reports a weekly window with a reset. */
export function weeklyPace(provider: ServerProvider, now: number): WeeklyPace | null {
  const windows = (provider.usageLimits?.windows ?? []).filter(
    (window) => window.kind === "weekly" && window.resetsAt,
  );
  let worst: WeeklyPace | null = null;
  for (const window of windows) {
    const duration = (window.windowDurationMins ?? 7 * 24 * 60) * 60_000;
    const remaining = Date.parse(window.resetsAt!) - now;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > duration) continue;
    const pace = {
      usedPercent: window.usedPercent,
      elapsedPercent: Math.round((1 - remaining / duration) * 100),
    };
    if (!worst || pace.usedPercent - pace.elapsedPercent > worst.usedPercent - worst.elapsedPercent)
      worst = pace;
  }
  return worst;
}

const step = <T extends string>(scale: readonly T[], value: T | "unknown", by: number) => {
  const index = scale.indexOf(value as T);
  return index === -1 ? value : scale[Math.max(0, Math.min(scale.length - 1, index + by))]!;
};

/** Applies the user's preference and weekly pacing on top of the judgment. */
export function adjustAdvice(
  judged: SelectionAdvice,
  preference: RoutingPreference,
  pace: WeeklyPace | null,
  task: string,
): { readonly advice: SelectionAdvice; readonly notes: readonly string[] } {
  let { capability, effort } = judged;
  const notes: string[] = [];
  if (preference === "save") {
    effort = step(EFFORTS, effort, -1);
    notes.push("saving usage");
  } else if (preference === "quality") {
    effort = step(EFFORTS, effort, 1);
    if (capability === "basic") capability = "standard";
    notes.push("favouring quality");
  }
  const ahead = pace ? pace.usedPercent - pace.elapsedPercent : 0;
  if (pace && ahead >= AHEAD) {
    // Hard work keeps its model; pacing takes effort first and the model only when far ahead.
    effort = step(EFFORTS, effort, -1);
    if (ahead >= WELL_AHEAD && capability === "standard") capability = "basic";
    notes.push(
      `ahead of weekly pace (${Math.round(pace.usedPercent)}% used, ${pace.elapsedPercent}% of the week gone)`,
    );
  }
  // Saving and pacing trim effort, but hard work is never left on the lowest setting.
  if (judged.capability === "advanced" && effort === "low" && judged.effort !== "low")
    effort = "medium";
  // Last word: writing a person will read is never judged basic or run on low effort by Auto,
  // whatever the judge, the saving preference or the weekly pace said.
  if (isWritingTask(task) && (capability === "basic" || effort === "low")) {
    if (capability === "basic") capability = "standard";
    if (effort === "low") effort = "medium";
    notes.push("writing for a reader is never turned down");
  }
  return { advice: { ...judged, capability, effort }, notes };
}

const effortDescriptor = (provider: ServerProvider, model: string) => {
  const descriptors =
    provider.models.find((item) => item.slug === model)?.capabilities?.optionDescriptors ?? [];
  for (const descriptor of descriptors)
    if (descriptor.type === "select" && EFFORT_OPTION_IDS.includes(descriptor.id))
      return descriptor;
  return undefined;
};

/** The effort a selection runs at: its own option, or the model's default when none is set. */
export const effortOf = (selection: ModelSelection, provider?: ServerProvider): string | null => {
  const value = selection.options?.find((option) => EFFORT_OPTION_IDS.includes(option.id))?.value;
  if (typeof value === "string") return value;
  const descriptor = provider && effortDescriptor(provider, selection.model);
  return (
    descriptor?.currentValue ?? descriptor?.options.find((choice) => choice.isDefault)?.id ?? null
  );
};

/** Picks model and effort inside one provider. Returns the input selection when nothing is clear. */
export function chooseSelection(input: {
  readonly provider: ServerProvider;
  readonly current: ModelSelection;
  readonly advice: SelectionAdvice;
  readonly ladder: RoutingLadder;
  readonly priceOf?: PriceOf;
}): { readonly selection: ModelSelection; readonly reason: string } {
  const { provider, current, advice, ladder } = input;
  const price = (model: string) => input.priceOf?.(model) ?? null;
  const notes: string[] = [];
  let model = current.model;
  if (advice.capability === "unknown" || advice.capabilityConfidence < MIN_CONFIDENCE)
    notes.push("kept the model (no clear signal)");
  else {
    const target = ladder[advice.capability];
    if (!target) notes.push(`kept the model (no ${advice.capability} model for this account)`);
    // Hard work never moves to a cheaper model: the thread is already on something stronger than
    // the top rung (Fable over Opus), and the top rung is a floor for hard work, not a ceiling.
    else if (
      advice.capability === "advanced" &&
      (price(current.model) ?? 0) > (price(target) ?? Number.POSITIVE_INFINITY)
    )
      notes.push("kept the model (it is stronger than Auto's pick for hard work)");
    // Without prices: a model that is neither a rung nor the account's default was chosen on
    // purpose, and may well be stronger than the top rung.
    else if (
      target !== current.model &&
      !Object.values(ladder).includes(current.model) &&
      !provider.models.find((item) => item.slug === current.model)?.isDefault
    )
      notes.push("kept the model (you chose one outside Auto's three)");
    else if (!provider.models.some((item) => item.slug === target))
      notes.push(`kept the model (${target} is not offered by this account)`);
    else {
      model = target;
      notes.push(`${advice.capability} task`);
    }
  }
  const descriptor = effortDescriptor(provider, model);
  const supported = new Set(
    (
      provider.models.find((item) => item.slug === model)?.capabilities?.optionDescriptors ?? []
    ).map((item) => item.id),
  );
  // Options from another model are meaningless on the new one.
  let options =
    model === current.model
      ? [...(current.options ?? [])]
      : (current.options ?? []).filter((option) => supported.has(option.id));
  if (advice.effort === "unknown" || advice.effortConfidence < MIN_CONFIDENCE)
    notes.push("kept the effort (no clear signal)");
  else if (!descriptor) {
    // A model with no effort setting has nothing to report.
  } else if (!descriptor.options.some((choice) => choice.id === advice.effort))
    notes.push(`kept the effort (this model has no ${advice.effort} setting)`);
  // Effort goes up for any task and down only for a simple one. Lowering it on ordinary or
  // hard work is the change people undo: the judge sees one message, not what it leads to.
  else if (
    advice.capability !== "basic" &&
    EFFORT_ORDER.indexOf(advice.effort) < EFFORT_ORDER.indexOf(effortOf(current, provider) ?? "")
  )
    notes.push("kept the effort (only simple tasks are turned down)");
  else {
    options = [
      ...options.filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: advice.effort },
    ];
    notes.push(`${advice.effort} effort`);
  }
  const judge =
    advice.judge === "jev" ? "Jev" : advice.judge === "reused" ? "Last judgment" : "Local rules";
  return {
    selection: {
      instanceId: current.instanceId,
      model,
      ...(options.length > 0 ? { options } : {}),
    },
    reason: `${judge}: ${notes.join(", ")}.`,
  };
}
