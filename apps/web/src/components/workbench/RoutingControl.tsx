import { useEffect, useRef, useState } from "react";
import { Route } from "lucide-react";
import { randomUUID } from "../../lib/utils";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type {
  JevAdvice,
  ManagedSkillLoad,
  ModelSelection,
  RoutingJudgmentError,
  EnvironmentId,
  ProviderInstanceId,
  RoutingAccountReason,
  RoutingPreview,
} from "@t3tools/contracts";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomCommand } from "../../state/use-atom-command";
import { usd, useRoutingPicks } from "./routingPicks";
import { ManagedSkillsControl } from "./ManagedSkillsControl";
import { JevConnectionControl } from "./JevConnectionControl";
import { AutomaticRoutingControl } from "./AutomaticRoutingControl";
import { RouteQualificationStatus } from "./RouteQualificationStatus";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const labels: Record<RoutingAccountReason, string> = {
  available: "Fresh allowance at last check",
  disabled: "Account disabled",
  unavailable: "Provider is not ready",
  sign_in_required: "Sign-in needs verification",
  identity_unknown: "Account identity not reported",
  quota_unknown: "Allowance not reported",
  quota_failed: "Allowance refresh failed",
  quota_stale: "Allowance needs refreshing",
  quota_reserved: "At or below the allowance reserve",
  no_models: "No models reported",
  shared_account: "Shares another account’s allowance",
};

const requestBasis = (task: string, preview: RoutingPreview) =>
  JSON.stringify([
    task,
    preview.jevRequest?.requestId,
    preview.skills.map(({ name, description }) => ({ name, description })),
  ]);

const judgmentErrors: Record<RoutingJudgmentError["reason"], string> = {
  not_configured: "Jev is not connected on this environment.",
  stale_preview: "Your draft or skills changed. Refresh Routing before asking Jev.",
  invalid_input: "Write a specific task before asking Jev.",
  price_unavailable: "Jev’s verified price is unavailable or has changed. No request was sent.",
  budget_blocked: "The selection budget cannot admit this request. Check the balance below.",
  already_requested:
    "This request was already attempted. Its charge may still be unresolved; it will not be sent again.",
  request_uncertain:
    "Jev’s result or charge could not be confirmed. Its reservation stays held; retrying this draft will not send it again.",
  invalid_response: "Jev returned an invalid recommendation. Any reported charge was recorded.",
  storage:
    "The recommendation could not be saved or recovered. Check this environment before trying again.",
};

export function RoutingControl({
  environmentId,
  instanceId,
  getModelSelection,
  cwd,
  getTask,
  canJudge = false,
  canConfigure = false,
  canLoadSkills = false,
  onSkillLoaded,
  threadId,
  refreshKey,
}: {
  /** With a thread, the control keeps that thread's Auto picks loaded for the timeline. */
  threadId?: string | null;
  /** Changes when the thread gains a message, so new picks are fetched. */
  refreshKey?: number;
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId | null;
  getModelSelection?: () => ModelSelection | undefined;
  cwd: string | null;
  getTask: () => string;
  canJudge?: boolean;
  canConfigure?: boolean;
  canLoadSkills?: boolean;
  onSkillLoaded?: (skill: ManagedSkillLoad) => "added" | "already_present" | "limit";
}) {
  const navigate = useNavigate();
  const preview = useAtomCommand(serverEnvironment.routingPreview, { reportFailure: false });
  const judge = useAtomCommand(serverEnvironment.routingJudge, { reportFailure: false });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const settings = useAtomValue(primaryServerSettingsAtom);
  const addPicks = useRoutingPicks((state) => state.addPicks);
  useEffect(() => {
    if (!threadId || settings.routingMode === "manual") return;
    let current = true;
    void preview({ environmentId, input: { instanceId, cwd: null, task: "", threadId } }).then(
      (response) => {
        if (current && response._tag === "Success") addPicks(response.value.threadDecisions ?? []);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [addPicks, environmentId, instanceId, preview, refreshKey, settings.routingMode, threadId]);
  const [result, setResult] = useState<RoutingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loadedTask = useRef<string | null>(null);
  const pending = useRef(false);
  const attempt = useRef<{
    task: string;
    basis: string;
    id: string;
    advice: JevAdvice | null;
  } | null>(null);
  const [judging, setJudging] = useState(false);
  const [advice, setAdvice] = useState<JevAdvice | null>(null);
  const [judgmentError, setJudgmentError] = useState<string | null>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const load = async (refreshSources: boolean) => {
    const requestId = ++generation.current;
    const current = () => requestId === generation.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setJudgmentError(null);
    setAdvice(null);
    try {
      if (refreshSources) {
        const updated = await refresh({ environmentId, input: {} });
        if (!current()) return;
        if (updated._tag === "Failure")
          setError("Some accounts could not refresh. Check each account below.");
        if (instanceId && cwd) {
          const skills = await refresh({ environmentId, input: { instanceId, cwd, fresh: true } });
          if (!current()) return;
          if (skills._tag === "Failure") setError("Could not refresh this project’s skills.");
        }
      }
      const task = getTask().slice(0, 4_000);
      const modelSelection = getModelSelection?.();
      const response = await preview({
        environmentId,
        input: { instanceId, cwd, task, ...(modelSelection ? { modelSelection } : {}) },
      });
      if (!current()) return;
      if (JSON.stringify(modelSelection) !== JSON.stringify(getModelSelection?.())) {
        setError("Your model changed. Reopen Routing to check the current selection.");
        return;
      }
      if (response._tag === "Success") {
        loadedTask.current = task;
        setResult(response.value);
        setAdvice(
          getTask().slice(0, 4_000) !== task
            ? null
            : response.value.jevRequest !== undefined
              ? (response.value.jevRequest?.advice ?? null)
              : attempt.current?.basis === requestBasis(task, response.value)
                ? attempt.current.advice
                : null,
        );
      } else setError("Routing preview is unavailable. Your manual model selection still works.");
    } catch {
      if (current()) setError("Could not reach this environment. Reconnect and try again.");
    } finally {
      if (current()) setBusy(false);
    }
  };
  const askJev = async () => {
    if (pending.current || !canJudge || !result?.jevConfigured) return;
    const task = getTask().slice(0, 4_000);
    if (!task.trim()) {
      setJudgmentError(judgmentErrors.invalid_input);
      return;
    }
    if (result.jevRequest !== undefined) {
      if (loadedTask.current !== task) {
        setJudgmentError(judgmentErrors.stale_preview);
        return;
      }
      if (!result.jevRequest) {
        setJudgmentError(judgmentErrors.storage);
        return;
      }
      if (result.jevRequest.advice) {
        setAdvice(result.jevRequest.advice);
        return;
      }
      if (result.jevRequest.state !== "new") {
        setJudgmentError(judgmentErrors.already_requested);
        return;
      }
    }
    const basis = requestBasis(task, result);
    if (attempt.current?.basis !== basis)
      attempt.current = {
        task,
        basis,
        id: result.jevRequest?.requestId ?? randomUUID(),
        advice: null,
      };
    if (attempt.current.advice) {
      setAdvice(attempt.current.advice);
      return;
    }
    const activeAttempt = attempt.current;
    const currentGeneration = generation.current;
    const current = () => currentGeneration === generation.current;
    pending.current = true;
    setJudging(true);
    setAdvice(null);
    setJudgmentError(null);
    try {
      const response = await judge({
        environmentId,
        input: { instanceId, cwd, task, requestId: activeAttempt.id },
      });
      if (response._tag === "Success") activeAttempt.advice = response.value;
      if (!current()) return;
      if (getTask().slice(0, 4_000) !== task) {
        setJudgmentError("Your draft changed. Reopen Routing to assess the current draft.");
      } else if (response._tag === "Success") {
        setAdvice(response.value);
      } else {
        const failure = Cause.findErrorOption(response.cause);
        setJudgmentError(
          Option.isSome(failure) && failure.value._tag === "RoutingJudgmentError"
            ? judgmentErrors[failure.value.reason]
            : "Could not retrieve Jev’s recommendation. Reconnect to recover this request without resending it.",
        );
      }
      const modelSelection = getModelSelection?.();
      const updated = await preview({
        environmentId,
        input: { instanceId, cwd, task, ...(modelSelection ? { modelSelection } : {}) },
      });
      if (current()) {
        if (JSON.stringify(modelSelection) !== JSON.stringify(getModelSelection?.())) {
          setResult(null);
          setError("Your model changed. Reopen Routing to check the current selection.");
        } else if (updated._tag === "Success") setResult(updated.value);
      }
    } catch {
      if (current())
        setJudgmentError(
          "Connection interrupted. Reopen Routing to recover this request without resending it.",
        );
    } finally {
      pending.current = false;
      setJudging(false);
    }
  };
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void load(false);
        else {
          generation.current++;
          setBusy(false);
          setResult(null);
        }
      }}
    >
      <PopoverTrigger aria-label="Routing And Skills" data-wb-routing-trigger="">
        <Route size={16} />{" "}
        {settings.routingMode === "manual"
          ? "Routing"
          : settings.routingMode === "shadow"
            ? "Auto (Trial)"
            : "Auto"}
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end" side="top">
        <div data-wb-usage="" data-wb-routing="" aria-busy={busy || judging}>
          <header>
            <h2>Auto</h2>
            <button type="button" disabled={busy || judging} onClick={() => void load(true)}>
              {busy ? "Checking…" : "Refresh"}
            </button>
          </header>

          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Checking this environment…</p>}
          {result && (
            <>
              <AutomaticRoutingControl
                environmentId={environmentId}
                preview={result}
                onChanged={() => void load(false)}
              />
              <details data-wb-routing-more="">
                <summary>Skills, Budget And Accounts</summary>
                <p>
                  Checked {new Date(result.checkedAt).toLocaleString()}. Refresh for current
                  balances.
                </p>
                <section>
                  <h3>Jev Selection Budget</h3>
                  {result.selectionBudget?.status === "ready" ? (
                    <>
                      <p>
                        {usd(result.selectionBudget.availableMicroUsd)} available of{" "}
                        {usd(result.selectionBudget.capMicroUsd)} per day.
                      </p>
                      <p>
                        {usd(result.selectionBudget.spentMicroUsd)} settled ·{" "}
                        {usd(result.selectionBudget.heldMicroUsd)} reserved
                      </p>
                      <p>
                        Resets at midnight {result.selectionBudget.timeZone}. Unresolved
                        reservations stay held.
                      </p>
                      {result.selectionBudget.unresolvedRequests > 0 && (
                        <p role="status">
                          {result.selectionBudget.unresolvedRequests} request(s) awaiting cost
                          reconciliation.
                        </p>
                      )}
                      {result.selectionBudget.halted && (
                        <p role="alert">
                          Selection spending is stopped: a charge exceeded its reservation. Review
                          required.
                        </p>
                      )}
                    </>
                  ) : (
                    <p>Budget unavailable. Paid selection remains off.</p>
                  )}
                  <p>
                    This environment’s selection budget is separate from task execution and other
                    API use.
                  </p>
                  {canJudge && result.jevConfigured ? (
                    <>
                      <p>
                        Ask Jev sends up to 4,000 characters of your draft and the name and
                        description of each available skill to TypeSafe. Each request reserves up to
                        $0.004032; its reported cost is reconciled afterward.
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || judging}
                        onClick={() => void askJev()}
                      >
                        {judging ? "Asking Jev…" : "Ask Jev"}
                      </Button>
                    </>
                  ) : (
                    <p>Jev requests are not enabled on this environment.</p>
                  )}
                  {result.jevRequest === undefined && canJudge && (
                    <p>Update this environment to recover requests after a full reload.</p>
                  )}
                  {result.jevRequest &&
                    result.jevRequest.state !== "new" &&
                    !result.jevRequest.advice && (
                      <p role="status">
                        This draft’s request is {result.jevRequest.state}. No validated
                        recommendation is available yet. Refresh to check its saved result; it will
                        not be sent again.
                      </p>
                    )}
                  {judging && <p role="status">Waiting for Jev’s recommendation…</p>}
                  {judgmentError && <p role="alert">{judgmentError}</p>}
                  {advice && (
                    <section aria-label="Jev Recommendation">
                      <h3>Jev Recommendation</h3>
                      <p>
                        Capability: {advice.capability} · Confidence{" "}
                        {Math.round(advice.confidence.capability * 100)}%
                      </p>
                      <p>
                        Reasoning effort: {advice.effort} · Confidence{" "}
                        {Math.round(advice.confidence.effort * 100)}%
                      </p>
                      <p>
                        Skill: {advice.skillName ?? "No skill selected"} · Confidence{" "}
                        {Math.round(advice.confidence.skill * 100)}%
                      </p>
                      <p>
                        Confidence reflects the choice distribution, not verified correctness.
                        Review this advice before choosing a model or skill.
                      </p>
                      <p>
                        Recorded cost {usd(advice.costMicroUsd)} · {advice.inputTokens} input tokens
                      </p>
                      <small>Receipt {advice.receiptId}</small>
                      <p>
                        Your model is unchanged by Jev. Jev does not submit tasks or load skill
                        instructions.
                      </p>
                    </section>
                  )}
                </section>
                {canLoadSkills && (
                  <ManagedSkillsControl
                    environmentId={environmentId}
                    cwd={cwd}
                    candidates={result.managedSkills ?? []}
                    available={result.managedCatalogAvailable === true}
                    onLoad={onSkillLoaded}
                    onManage={() =>
                      void navigate({ to: "/settings/skills", search: { machine: environmentId } })
                    }
                  />
                )}
                {result.qualification && (
                  <RouteQualificationStatus qualification={result.qualification} />
                )}
                {canConfigure && (
                  <JevConnectionControl
                    environmentId={environmentId}
                    configured={result.jevConfigured === true}
                    onChanged={() => void load(false)}
                  />
                )}
                <section>
                  <h3>Account Allowances</h3>
                  <p>
                    {result.reservePercent}% reserve · Reports older than five minutes need
                    refreshing.
                  </p>
                  {result.accounts.length === 0 && (
                    <p>No accounts are configured in this environment.</p>
                  )}
                  {result.accounts.map((account) => (
                    <div data-wb-route-account="" key={account.instanceId}>
                      <strong>{account.name}</strong>
                      <span>
                        {account.remainingPercent === null
                          ? "Unknown"
                          : `${Math.round(account.remainingPercent)}% last reported remaining`}
                      </span>
                      <small>
                        {labels[account.reason]}
                        {account.instanceId === result.recommendedInstanceId
                          ? " · Most headroom at last check"
                          : ""}
                      </small>
                      {account.quotaCheckedAt && (
                        <small>Reported {new Date(account.quotaCheckedAt).toLocaleString()}</small>
                      )}
                    </div>
                  ))}
                  <p>
                    Allowance alone does not establish model suitability. Free and API accounts
                    without reported quotas remain available through manual selection.
                  </p>
                </section>
                <section>
                  <h3>Skills For This Draft</h3>
                  <p>
                    Local matches from this provider and the managed catalog. These descriptions are
                    candidates for an optional Jev recommendation.
                  </p>
                  {!result.skillCatalogAvailable && result.skills.length === 0 ? (
                    <p>Refresh to discover this project’s skills.</p>
                  ) : result.skills.length === 0 ? (
                    <p>No close match. Add a specific task to your draft and refresh.</p>
                  ) : (
                    result.skills.map((skill) => (
                      <div data-wb-route-account="" key={skill.name}>
                        <strong>{skill.name}</strong>
                        <span>{skill.description}</span>
                        <small>Matched: {skill.matchedTerms.join(", ")}</small>
                      </div>
                    ))
                  )}
                </section>
              </details>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
