import type {
  JevAdvice,
  ManagedSkillCandidate,
  ModelSelection,
  RoutingDecision,
  JevConnectionInput,
  JevConnectionState,
  RoutingJudgmentInput,
  RoutingJudgmentError,
  RoutingPreview,
  RoutingPreviewInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import { splitAgentMessage } from "@t3tools/shared/agentMessage";
import {
  countManagedSkillBlocks,
  managedSkillBlock,
  RoutingJudgmentError as JudgmentError,
} from "@t3tools/contracts";
import * as ManagedSkillCatalog from "../skills/ManagedSkillCatalog.ts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as RoutingDecisionStore from "./RoutingDecisionStore.ts";
import {
  adjustAdvice,
  chooseSelection,
  effortOf,
  isBareReply,
  isFollowUp,
  localAdvice,
  mergeAdvice,
  type PriceOf,
  resolveLadder,
  type SelectionAdvice,
  weeklyPace,
} from "./automaticSelection.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as SelectionBudgetStore from "./SelectionBudgetStore.ts";
import * as JevAdvisor from "./JevAdvisor.ts";
import { candidateRank, dropDuplicateCandidates } from "./candidateDuplicates.ts";
import { JEV_MAX_SKILLS } from "./jevProtocol.ts";
import * as Qualification from "./RouteQualificationService.ts";
import { BLOCKED, previewRouting } from "./routingPolicy.ts";
import { predictSelection } from "./routingPrediction.ts";
import { summarizeSavings } from "./routingSavings.ts";
import { explicitSkillNames, leadingSlashName } from "../skills/explicitSkillNames.ts";
import { hidesSkillListing } from "../skills/skillListing.ts";

export class RoutingService extends Context.Service<
  RoutingService,
  {
    readonly skillsAdmitStarters: ManagedSkillCatalog.ManagedSkillCatalog["Service"]["admitStarters"];
    readonly skillsSyncLibrary: ManagedSkillCatalog.ManagedSkillCatalog["Service"]["syncLibrary"];
    readonly skillsAdmit: ManagedSkillCatalog.ManagedSkillCatalog["Service"]["admit"];
    readonly skillsSetEnabled: ManagedSkillCatalog.ManagedSkillCatalog["Service"]["setEnabled"];
    readonly skillsList: ManagedSkillCatalog.ManagedSkillCatalog["Service"]["list"];
    readonly skillsLoad: ManagedSkillCatalog.ManagedSkillCatalog["Service"]["load"];
    readonly configure: (
      input: JevConnectionInput,
    ) => Effect.Effect<JevConnectionState, RoutingJudgmentError>;
    readonly judge: (input: RoutingJudgmentInput) => Effect.Effect<JevAdvice, RoutingJudgmentError>;
    readonly preview: (input: RoutingPreviewInput) => Effect.Effect<RoutingPreview>;
    /**
     * Decides the model for one sent message and records the decision. Returns
     * the selection to run with: the router's pick in automatic mode, the
     * arriving selection otherwise. Never fails; any fault keeps the arriving selection.
     */
    readonly select: (input: SelectInput) => Effect.Effect<RoutedSelection>;
  }
>()("t3/routing/RoutingService") {}

/** The model a message will run on, and the skill text Auto adds to it, if any. */
export interface RoutedSelection {
  readonly selection: ModelSelection;
  readonly skill: string | null;
  /**
   * The message as the provider should read it, when it differs from what was typed. A leading
   * `/name` that stands for a managed skill becomes `$name`: with the provider's own list hidden,
   * its CLI would otherwise try to run `/name` as a command it does not know.
   */
  readonly text?: string;
}

export interface SelectInput {
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId?: string;
  readonly text: string;
  readonly attachmentCount: number;
  readonly current: ModelSelection;
  /** The user chose this model for this message. */
  readonly pinned: boolean;
  readonly newThread: boolean;
}

// Sending waits on the judge for at most this long before local rules decide.
const JEV_WAIT = "4 seconds";
// A named skill and Jev's picks together; more than this crowds the message.
const MAX_ATTACHED_SKILLS = 4;
const SKILL_RESYNC_MS = 10 * 60 * 1000;

const managedRank = (skill: Pick<ManagedSkillCandidate, "source" | "dependencies">) =>
  skill.source.startsWith("plugin-library:")
    ? candidateRank.plugin
    : !skill.source.startsWith("local-library:")
      ? candidateRank.reviewed
      : /\/skill-library\//.test(skill.dependencies[0]?.path ?? "")
        ? candidateRank.downloaded
        : candidateRank.own;

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
  const advisor = yield* JevAdvisor.JevAdvisor;
  const qualification = yield* Qualification.RouteQualificationService;
  const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
  // Prices order the models of a family whose names do not. Without the usage service (tests,
  // a stripped-down server) the ladder falls back to names alone.
  const usage = yield* Effect.serviceOption(UsageService.UsageService);
  const modelRates = Option.isSome(usage)
    ? usage.value.modelRates.pipe(Effect.catchCause(() => Effect.succeed(() => null)))
    : Effect.succeed(() => null);
  const modelPrices = modelRates.pipe(
    Effect.map((rateOf): PriceOf => (model) => {
      const rate = rateOf(model);
      return rate ? rate.inputCostPerToken + rate.outputCostPerToken : null;
    }),
  );
  // With the provider's own skill list hidden, or Jev connected to pick from it, the library is
  // the list that matters, so the user's own and plugin skills are switched on for them.
  // Downloads stay off until their group is switched on. Safe to repeat and never fatal: a
  // failure only means the library is as it was.
  const lastSync = yield* Ref.make(0);
  const enableOwnSkills = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    if (current.skillListing !== "selected" && !(yield* advisor.configured)) return;
    yield* Ref.set(lastSync, yield* Clock.currentTimeMillis);
    yield* catalog.syncLibrary({ enable: true });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not switch on the user's skills", { cause }),
    ),
  );
  // A message picks up a skill added since the last sync, at most once every ten minutes. This
  // is the fallback for what the folder watch below cannot see, such as a symlinked skill.
  const refreshOwnSkills = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    if (at - (yield* Ref.get(lastSync)) >= SKILL_RESYNC_MS) yield* enableOwnSkills;
  });
  const changes = yield* settings.subscribeChanges;
  const listing = yield* Ref.make<string | null>(null);
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* settings.ready;
      yield* enableOwnSkills;
      yield* Ref.set(listing, (yield* settings.getSettings).skillListing);
      yield* changes.pipe(
        Stream.runForEach((next) =>
          Ref.getAndSet(listing, next.skillListing).pipe(
            Effect.flatMap((before) =>
              before === next.skillListing ? Effect.void : enableOwnSkills,
            ),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("skill auto-enable stopped", { cause })),
    ),
  );
  // New or edited skill files switch on without a restart or a message.
  yield* Effect.forkScoped(
    catalog.libraryChanges().pipe(
      Stream.runForEach(() => enableOwnSkills),
      Effect.catchCause((cause) => Effect.logWarning("skill folder watch stopped", { cause })),
    ),
  );
  const candidateState = Effect.fn("RoutingService.candidateState")(function* (
    input: RoutingPreviewInput,
  ) {
    const local = previewRouting(
      yield* registry.getProviders,
      input,
      yield* Clock.currentTimeMillis,
    );
    const managed = yield* catalog.candidates(input);
    const eligible = managed.filter((skill) => skill.missingDependencies.length === 0);
    const references = explicitSkillNames(input.task);
    const explicit = (name: string) =>
      references.has(name.toLowerCase()) ||
      (name.startsWith("managed:") && references.has(name.slice(8).toLowerCase()));
    const skills = [
      ...eligible.map((skill) => ({
        name: `managed:${skill.id}`,
        description: skill.description,
        matchedTerms: skill.matchedTerms,
      })),
      ...local.skills,
    ]
      .sort((a, b) => Number(explicit(b.name)) - Number(explicit(a.name)))
      .slice(0, 3);
    // Jev judges against every usable skill, not only the keyword matches shown while
    // typing: with a large library the right skill often shares no words with the task.
    yield* refreshOwnSkills;
    const usable = yield* catalog.usable({ cwd: input.cwd });
    // The same skill often arrives twice: a copy in the user's folder and the plugin's own, or a
    // provider listing either. Jev sees it once, under the copy the user wrote.
    const judged = dropDuplicateCandidates<{
      name: string;
      description: string;
      matchedTerms: readonly string[];
      rank: number;
      sha256?: string;
    }>(
      [
        ...usable.map((skill) => ({
          name: `managed:${skill.id}`,
          description: skill.description,
          matchedTerms: skill.matchedTerms,
          rank: managedRank(skill),
          sha256: skill.sourceSha256,
        })),
        ...local.skills.map((skill) => ({ ...skill, rank: candidateRank.provider })),
      ],
      explicit,
    )
      .slice(0, JEV_MAX_SKILLS)
      .map(({ rank: _rank, sha256: _sha256, ...skill }) => skill);
    const revisions = usable
      .filter((skill) => judged.some((s) => s.name === `managed:${skill.id}`))
      .map((skill) => skill.revision);
    const catalogRevision = revisions.length
      ? NodeCrypto.createHash("sha256").update(revisions.join(":")).digest("hex")
      : undefined;
    return {
      local,
      managed,
      usable,
      skills,
      judged,
      scope: { ...input, ...(catalogRevision ? { catalogRevision } : {}) },
    };
  });
  const preview = Effect.fn("RoutingService.preview")(function* (input: RoutingPreviewInput) {
    const state = yield* candidateState(input).pipe(
      Effect.catchTag("ManagedSkillError", () => Effect.succeed(null)),
    );
    const result =
      state?.local ??
      previewRouting(yield* registry.getProviders, input, yield* Clock.currentTimeMillis);
    const skills = state?.skills ?? result.skills;
    const selectionBudget = yield* budget.snapshot.pipe(
      Effect.catchTag("SelectionBudgetError", () =>
        Effect.succeed({ status: "unavailable" as const }),
      ),
    );
    const jevRequest = input.task.trim()
      ? yield* advisor
          .recover({
            task: input.task,
            skills: state?.judged ?? skills,
            scope: state?.scope ?? input,
          })
          .pipe(Effect.catchTag("RoutingJudgmentError", () => Effect.succeed(null)))
      : null;
    const routingSettings = yield* settings.getSettings.pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const mode = routingSettings?.routingMode ?? "manual";
    const ladders = routingSettings?.routingLadders ?? {};
    const providers = yield* registry.getProviders;
    const priceOf = yield* modelPrices;
    const now = yield* Clock.currentTimeMillis;
    const counts = yield* decisions.scorecard.pipe(Effect.catch(() => Effect.succeed(null)));
    const moved = yield* decisions.movedThreads.pipe(Effect.catch(() => Effect.succeed(null)));
    const scorecard =
      counts && moved
        ? {
            ...counts,
            savings: summarizeSavings(moved.moves, moved.jevMicroUsd, yield* modelRates),
          }
        : counts;
    // Only a thread's first message is routed, so a prediction means nothing for an existing one.
    const predicted =
      mode !== "manual" && input.modelSelection && !input.threadId
        ? predictSelection({
            providers,
            current: input.modelSelection,
            task: input.task,
            preference: routingSettings?.routingPreference ?? "balanced",
            pacing: routingSettings?.routingPacing ?? true,
            ladders,
            recoveredJev: state ? (jevRequest?.advice ?? null) : null,
            priceOf,
            now,
          })
        : null;
    return {
      ...result,
      ...(predicted ? { predicted } : {}),
      mode: mode === "manual" ? ("advisory" as const) : mode,
      automaticExecution: mode === "automatic",
      ...(scorecard ? { scorecard } : {}),
      ...(input.threadId
        ? {
            threadDecisions: yield* decisions
              .forThread(input.threadId)
              .pipe(Effect.catch(() => Effect.succeed([]))),
          }
        : {}),
      preference: routingSettings?.routingPreference ?? "balanced",
      pacing: routingSettings?.routingPacing ?? true,
      skillListing: routingSettings?.skillListing ?? "all",
      pace: (() => {
        const selected = providers.find((item) => item.instanceId === input.instanceId);
        return selected ? weeklyPace(selected, now) : null;
      })(),
      ladders,
      accounts: result.accounts.map((account) => {
        const provider = providers.find((item) => item.instanceId === account.instanceId);
        return provider
          ? {
              ...account,
              ladder: resolveLadder(provider, ladders[provider.instanceId], priceOf),
              models: provider.models.map(({ slug, name }) => ({ slug, name })),
            }
          : account;
      }),
      ...(input.modelSelection && input.modelSelection.instanceId === input.instanceId
        ? { qualification: yield* qualification.inspect(input.modelSelection) }
        : {}),
      skills,
      // Jev may choose a skill the keyword match never surfaced; show it so it can be loaded.
      managedSkills: [
        ...(state?.managed ?? []),
        ...(state?.usable ?? []).filter(
          (skill) =>
            jevRequest?.advice?.skillName === `managed:${skill.id}` &&
            !state?.managed.some((shown) => shown.id === skill.id),
        ),
      ],
      managedCatalogAvailable: state !== null,
      starterSkillsAvailable: true,
      selectionBudget,
      jevConfigured: yield* advisor.configured,
      jevRequest: state ? jevRequest : null,
    };
  });
  const judge = Effect.fn("RoutingService.judge")(function* (input: RoutingJudgmentInput) {
    const state = yield* candidateState(input).pipe(
      Effect.mapError(() => new JudgmentError({ reason: "storage" })),
    );
    return yield* advisor.assess({
      requestId: input.requestId,
      task: input.task,
      skills: state.judged,
      scope: state.scope,
    });
  });
  // Jev is billed once it is sent, so a slow reply is left to settle on its own
  // fiber rather than interrupted into an unresolved reservation.
  const jevAdvice = Effect.fn("RoutingService.jevAdvice")(function* (input: RoutingPreviewInput) {
    if (!(yield* advisor.configured)) return null;
    const state = yield* candidateState(input);
    const request = { task: input.task, skills: state.judged, scope: state.scope };
    const known = yield* advisor.recover(request);
    if (known.advice) return known.advice;
    if (known.state !== "new") return null;
    const fiber = yield* Effect.forkDetach(
      advisor.assess({ ...request, requestId: known.requestId }),
    );
    return Option.getOrNull(yield* Fiber.join(fiber).pipe(Effect.timeoutOption(JEV_WAIT)));
  });
  const decide = Effect.fn("RoutingService.select")(function* (input: SelectInput) {
    const routingSettings = yield* settings.getSettings;
    const { routingMode, routingLadders, routingPreference, routingPacing } = routingSettings;
    const keep: RoutedSelection = { selection: input.current, skill: null };
    if (routingMode === "manual") return keep;
    const previous = yield* decisions.lastForThread(input.threadId);
    if (input.pinned) {
      // Only a pick that changed something can be overridden, and it is usually several messages
      // back: the thread's first. Counting the latest decision instead made every mid-thread
      // model change look like the router being overruled.
      const picked = (yield* decisions.forThread(input.threadId)).find(
        (decision) =>
          decision.applied &&
          (decision.fromInstanceId !== decision.toInstanceId ||
            decision.fromModel !== decision.toModel ||
            decision.fromEffort !== decision.toEffort),
      );
      if (
        picked &&
        !picked.overridden &&
        (picked.toModel !== input.current.model || picked.toEffort !== effortOf(input.current))
      )
        yield* decisions.markOverridden(picked.commandId);
      return keep;
    }
    const providers = yield* registry.getProviders;
    const priceOf = yield* modelPrices;
    // An agent's thread arrives with its history ahead of the request. Everything Auto reads
    // (the judge, `$name`, `/name`) comes from what the person typed, never from that history.
    const { request } = splitAgentMessage(input.text);
    const task = request.slice(0, 4_000);
    let current = input.current;
    let moved: string | null = null;
    if (input.newThread) {
      const status = previewRouting(
        providers,
        { instanceId: current.instanceId, task: "", cwd: null },
        yield* Clock.currentTimeMillis,
      );
      const account = status.accounts.find((item) => item.instanceId === current.instanceId);
      const target = providers.find((item) => item.instanceId === status.recommendedInstanceId);
      const model =
        target &&
        (resolveLadder(target, routingLadders[target.instanceId], priceOf).standard ??
          target.models.find((item) => item.isDefault)?.slug ??
          target.models[0]?.slug);
      if (account && BLOCKED.has(account.reason) && target && model) {
        current = { instanceId: target.instanceId, model };
        moved = `${account.name} ${
          account.reason === "quota_reserved" ? "is near its limit" : "is not available"
        }, so this started on ${target.displayName ?? target.instanceId}. `;
      }
    }
    const provider = providers.find((item) => item.instanceId === current.instanceId);
    if (!provider) return keep;
    let advice: SelectionAdvice | null = null;
    let jevSkills: readonly string[] = [];
    if (isFollowUp(task) && previous)
      advice = {
        judge: "reused",
        capability: previous.capability,
        effort: previous.effort,
        capabilityConfidence: 1,
        effortConfidence: 1,
      };
    if (!advice) {
      // Jev is asked whenever it is connected. Keyword rules used to wave short questions past it
      // as trivial, and "why is this broken?" is a short question.
      const jev =
        !input.newThread && isBareReply(task)
          ? null
          : yield* jevAdvice({ instanceId: current.instanceId, task, cwd: null }).pipe(
              Effect.catch(() => Effect.succeed(null)),
            );
      advice = jev ? mergeAdvice(jev) : localAdvice(task, input.attachmentCount);
      // Text Jev calls no task of its own has no skill either, whatever the skill vote said.
      jevSkills =
        !jev || jev.capability === "unknown"
          ? []
          : (jev.skillNames ?? (jev.skillName ? [jev.skillName] : []));
    }
    // Skills are attached only when Auto is on, only from the managed catalog, and never on
    // top of a skill the user already put in the message. A skill named in the message
    // (`$name`) is always attached; Jev's picks follow. One that cannot be loaded (changed
    // on disk, missing file) is left out rather than blocking the send.
    let slashId: string | null = null;
    let slashAttached = false;
    const attached =
      routingMode === "automatic" && countManagedSkillBlocks(request) === 0
        ? yield* Effect.gen(function* () {
            const usable = yield* catalog.usable({ cwd: null });
            const named = new Set(explicitSkillNames(request));
            // With the list hidden, `/name` is how a person asks for a skill by hand. A name that
            // is not a usable managed skill is left alone: it may be a real slash command.
            const slash = hidesSkillListing(routingSettings) ? leadingSlashName(request) : null;
            const slashSkill = slash
              ? usable.find((skill) => skill.id === slash || skill.name.toLowerCase() === slash)
              : undefined;
            if (slash && slashSkill) {
              named.add(slashSkill.id);
              slashId = slashSkill.id;
            }
            const wanted = [
              ...usable
                .filter((skill) => named.has(skill.id) || named.has(skill.name.toLowerCase()))
                .map((skill) => skill.id),
              ...jevSkills
                .filter((name) => name.startsWith("managed:"))
                .map((name) => name.slice("managed:".length)),
            ];
            const blocks: { name: string; block: string }[] = [];
            for (const id of [...new Set(wanted)].slice(0, MAX_ATTACHED_SKILLS)) {
              const skill = usable.find((item) => item.id === id);
              const stage =
                skill?.stages.find((item) => item.stage === "implement") ?? skill?.stages[0];
              if (!skill || !stage) continue;
              const loaded = yield* catalog
                .load({ id, revision: skill.revision, stage: stage.stage, cwd: null })
                .pipe(Effect.catch(() => Effect.succeed(null)));
              if (loaded) {
                blocks.push({ name: skill.name, block: managedSkillBlock(loaded) });
                if (id === slashId) slashAttached = true;
              }
            }
            return blocks;
          }).pipe(Effect.catch(() => Effect.succeed([])))
        : [];
    const adjusted = adjustAdvice(
      advice,
      routingPreference,
      routingPacing ? weeklyPace(provider, yield* Clock.currentTimeMillis) : null,

      task,
    );
    const choice = chooseSelection({
      provider,
      current,
      advice: adjusted.advice,
      ladder: resolveLadder(provider, routingLadders[provider.instanceId], priceOf),
      priceOf,
    });
    // A provider caches a conversation per model and per reasoning setting. Changing either in a
    // thread that already ran makes it read the whole conversation again at full price, which
    // costs far more than any one message saves. Only a thread's first message is routed.
    const held = !input.newThread;
    const selection = held ? input.current : choice.selection;
    const reason = held
      ? "Kept this thread's model and effort: changing them mid-thread re-reads the whole conversation."
      : `${moved ?? ""}${choice.reason}${
          adjusted.notes.length > 0 ? ` Adjusted: ${adjusted.notes.join("; ")}.` : ""
        }`;
    const decision: RoutingDecision = {
      commandId: input.commandId,
      threadId: input.threadId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      decidedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      mode: routingMode,
      judge: advice.judge,
      capability: adjusted.advice.capability,
      effort: adjusted.advice.effort,
      fromInstanceId: input.current.instanceId,
      fromModel: input.current.model,
      fromEffort: effortOf(input.current, provider),
      toInstanceId: selection.instanceId,
      toModel: selection.model,
      toModelName:
        provider.models.find((item) => item.slug === selection.model)?.name ?? selection.model,
      toEffort: effortOf(selection, provider),
      applied: routingMode === "automatic",
      reason,
      ...(attached[0] ? { skillName: attached[0].name } : {}),
      ...(attached.length > 1 ? { skillNames: attached.map((skill) => skill.name) } : {}),
      overridden: false,
    };
    yield* decisions.record(decision);
    return routingMode === "automatic"
      ? {
          selection: selection,
          skill: attached.length ? attached.map((skill) => skill.block).join("\n\n") : null,
          // The agent's history stays ahead of the request, untouched.
          ...(slashAttached
            ? {
                text:
                  input.text.slice(0, input.text.length - request.length) +
                  request.replace(/^(\s*)\//, (_, space: string) => `${space}$`),
              }
            : {}),
        }
      : keep;
  });
  const select = (input: SelectInput) =>
    decide(input).pipe(
      Effect.catch(() => Effect.succeed({ selection: input.current, skill: null })),
      Effect.catchDefect(() => Effect.succeed({ selection: input.current, skill: null })),
    );
  return RoutingService.of({
    preview,
    judge,
    select,
    configure: (input) =>
      advisor
        .configure(input)
        .pipe(Effect.tap((state) => (state.configured ? enableOwnSkills : Effect.void))),
    skillsAdmit: catalog.admit,
    skillsAdmitStarters: catalog.admitStarters,
    skillsSyncLibrary: catalog.syncLibrary,
    skillsSetEnabled: catalog.setEnabled,
    skillsList: catalog.list,
    skillsLoad: catalog.load,
  });
});

export const layer = Layer.effect(RoutingService, make);
