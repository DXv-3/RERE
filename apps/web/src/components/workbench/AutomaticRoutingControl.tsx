import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  RoutingLadder,
  RoutingPreference,
  RoutingPreview,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { pickSummary, savingsSummary, usd } from "./routingPicks";
import { loadingProblem } from "../settings/SkillsSettings.logic";

const preferences: ReadonlyArray<{ id: RoutingPreference; label: string; detail: string }> = [
  {
    id: "save",
    label: "Save Usage",
    detail: "Raises effort less often. Simple tasks still drop to the small model.",
  },
  { id: "balanced", label: "Balanced", detail: "Matches the model and effort to each task." },
  {
    id: "quality",
    label: "Best Quality",
    detail: "Leans toward stronger models and higher effort.",
  },
];
const tiers = [
  { id: "basic", label: "Simple" },
  { id: "standard", label: "Everyday" },
  { id: "advanced", label: "Hard" },
] as const;

/** Auto routing: one switch, one preference, one pacing option. Everything else is under Advanced. */
export function AutomaticRoutingControl({
  environmentId,
  preview,
  onChanged,
}: {
  environmentId: EnvironmentId;
  preview: RoutingPreview;
  onChanged: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const on = preview.mode !== "advisory";
  const shadow = preview.mode === "shadow";
  const preference = preview.preference ?? "balanced";
  const save = async (patch: ServerSettingsPatch) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await update({ environmentId, input: { patch } });
      if (!mounted.current) return;
      if (result._tag === "Success") onChanged();
      else
        setError("Could not save. Only an administrator of this environment can change routing.");
    } catch {
      if (mounted.current)
        setError("Connection interrupted. Refresh Routing to check whether the change was saved.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const setTier = (
    instanceId: RoutingPreview["accounts"][number]["instanceId"],
    tier: (typeof tiers)[number]["id"],
    slug: string,
  ) => {
    // Only the person's own choices are saved; every other tier stays automatic.
    const chosen: RoutingLadder = preview.ladders?.[instanceId] ?? {};
    const { [tier]: _removed, ...rest } = chosen;
    const ladder = slug ? { ...rest, [tier]: slug } : rest;
    void save({ routingLadders: { ...preview.ladders, [instanceId]: ladder } });
  };
  const pace = preview.pace;
  const ahead = pace ? Math.round(pace.usedPercent - pace.elapsedPercent) : 0;
  const scorecard = preview.scorecard;
  const last = scorecard?.recent[0];
  const saved = savingsSummary(scorecard?.savings);
  const skillsHint =
    preview.skillListing === "selected"
      ? (loadingProblem(preview) ??
        "Jev picks skills for each message. None of them cost tokens until one is used.")
      : "Every provider lists its own skills in every session, used or not.";
  const paceHint = !pace
    ? "This account reports no weekly allowance."
    : ahead >= 10
      ? `${Math.round(pace.usedPercent)}% used with ${pace.elapsedPercent}% of the week gone. ${
          preview.pacing === false
            ? "Turn this on to stretch what is left."
            : "Auto is using lighter settings to stretch what is left."
        }`
      : `On pace: ${Math.round(pace.usedPercent)}% used with ${pace.elapsedPercent}% of the week gone.`;
  return (
    <section aria-label="Auto Routing" data-wb-auto-routing="">
      <div data-wb-auto-head="">
        <p>
          {on
            ? "Picks the model and effort for each new thread. A model you pick yourself is left alone."
            : "Messages run on the model you pick."}
        </p>
        <div role="group" aria-label="Auto Routing" data-wb-routing-modes="">
          <Button
            size="sm"
            variant={on ? "default" : "outline"}
            aria-pressed={on}
            disabled={busy || on}
            onClick={() => void save({ routingMode: "automatic" })}
          >
            On
          </Button>
          <Button
            size="sm"
            variant={on ? "outline" : "default"}
            aria-pressed={!on}
            disabled={busy || !on}
            onClick={() => void save({ routingMode: "manual" })}
          >
            Off
          </Button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {on && (
        <>
          {last && (
            <p data-wb-route-last="">
              <span>Last pick</span>
              <strong>{pickSummary(last)}</strong>
              {last.applied ? "" : " (not applied)"}
            </p>
          )}
          {saved && (
            <p data-wb-route-last="" data-wb-route-saved="">
              <span>So far</span>
              <strong>{saved.headline}</strong>
            </p>
          )}
          <div data-wb-auto-row="">
            <div role="group" aria-label="Preference" data-wb-routing-modes="">
              {preferences.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={item.id === preference ? "default" : "outline"}
                  aria-pressed={item.id === preference}
                  disabled={busy || item.id === preference}
                  onClick={() => void save({ routingPreference: item.id })}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <small>{preferences.find((item) => item.id === preference)?.detail}</small>
          </div>
          <div data-wb-auto-row="">
            <label data-wb-routing-check="">
              <input
                type="checkbox"
                checked={preview.pacing !== false}
                disabled={busy}
                onChange={(event) => void save({ routingPacing: event.target.checked })}
              />
              Make It Last The Week
            </label>
            <small>{paceHint}</small>
          </div>
          <div data-wb-auto-row="">
            <label data-wb-routing-check="">
              <input
                type="checkbox"
                checked={preview.skillListing === "selected"}
                disabled={busy}
                onChange={(event) =>
                  void save({ skillListing: event.target.checked ? "selected" : "all" })
                }
              />
              Load Only The Skills Each Message Needs
            </label>
            <small>{skillsHint}</small>
          </div>
          <p data-wb-auto-foot="">
            {preview.jevConfigured
              ? "Judged by Jev."
              : "Judged by built-in rules. Connect a Jev key under Skills, Budget And Accounts for sharper picks."}
            {preview.selectionBudget?.status === "ready" && (
              <span data-wb-jev-spend="">
                {" "}
                Jev spend today: {usd(preview.selectionBudget.spentMicroUsd)} of{" "}
                {usd(preview.selectionBudget.capMicroUsd)}.
              </span>
            )}
          </p>
          <details>
            <summary>Models And Recent Picks</summary>
            <div data-wb-auto-more="">
              <p>
                Auto works out each account’s models from their names and prices. Change a row only
                if a pick looks wrong; Automatic hands it back.
              </p>
              {preview.accounts.map((account) =>
                account.models && account.models.length > 0 ? (
                  <div data-wb-route-ladder="" key={account.instanceId}>
                    <strong>{account.name}</strong>
                    {tiers.map((tier) => {
                      const chosen = preview.ladders?.[account.instanceId]?.[tier.id];
                      const picked = account.models?.find(
                        (model) => model.slug === account.ladder?.[tier.id],
                      );
                      return (
                        <label key={tier.id}>
                          {tier.label}
                          <select
                            disabled={busy}
                            value={chosen ?? ""}
                            onChange={(event) =>
                              setTier(account.instanceId, tier.id, event.target.value)
                            }
                          >
                            <option value="">
                              {chosen
                                ? "Automatic"
                                : picked
                                  ? `Automatic: ${picked.name}`
                                  : "Automatic: effort only"}
                            </option>
                            {account.models?.map((model) => (
                              <option key={model.slug} value={model.slug}>
                                {model.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                ) : null,
              )}
              {saved && (
                <div data-wb-route-savings="">
                  <strong>What Auto Has Saved</strong>
                  {saved.lines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                  <small>{saved.note}</small>
                </div>
              )}
              {scorecard && scorecard.total > 0 && (
                <>
                  <p>
                    {scorecard.total} messages judged · {scorecard.changed} changed ·{" "}
                    {scorecard.overridden} overridden by you
                  </p>
                  <ol data-wb-route-decisions="">
                    {scorecard.recent.map((decision) => (
                      <li key={decision.commandId}>
                        <strong>{pickSummary(decision)}</strong>
                        <span>
                          {decision.applied ? "Applied" : "Not applied"}
                          {decision.overridden ? " · Overridden" : ""} ·{" "}
                          {new Date(decision.decidedAt).toLocaleString()}
                        </span>
                        <small>{decision.reason}</small>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <label data-wb-routing-check="">
                <input
                  type="checkbox"
                  checked={shadow}
                  disabled={busy}
                  onChange={(event) =>
                    void save({ routingMode: event.target.checked ? "shadow" : "automatic" })
                  }
                />
                Trial Run: Record Picks Without Applying Them
              </label>
              {preview.skillListing === "selected" && (
                <p data-wb-skill-providers="">
                  Claude, OpenCode and Antigravity start with no skills listed, and so does Codex
                  when it runs from its own CodeWrench home. Grok stops reading your Claude and
                  Cursor skill folders but still lists skills of its own. A Codex set up to use your
                  own ~/.codex folder directly, and Cursor, which has no setting for this, still
                  list theirs.
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/skills" })}
              >
                Open Skills Settings
              </Button>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
