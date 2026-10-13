import type { RoutingDecision, RoutingSavings } from "@t3tools/contracts";
import { create } from "zustand";

interface RoutingPicksState {
  picks: Record<string, RoutingDecision>;
  addPicks: (decisions: ReadonlyArray<RoutingDecision>) => void;
}
/** The router's pick per sent message, filled by the Routing control for the open thread. */
export const useRoutingPicks = create<RoutingPicksState>()((set) => ({
  picks: {},
  addPicks: (decisions) =>
    set((state) => {
      const fresh = decisions.filter(
        (decision) => decision.messageId && !state.picks[decision.messageId],
      );
      if (fresh.length === 0) return state;
      return {
        picks: {
          ...state.picks,
          ...Object.fromEntries(fresh.map((decision) => [decision.messageId!, decision])),
        },
      };
    }),
}));

/** How the pick was made, in the words a person would use. */
export const judgedBy = (decision: Pick<RoutingDecision, "judge">) =>
  decision.judge === "jev"
    ? "Judged by Jev"
    : decision.judge === "reused"
      ? "Same as the last message"
      : "Local rules";

/** The attached skills' names, most relevant first; empty when none were attached. */
export const attachedSkills = (decision: Pick<RoutingDecision, "skillName" | "skillNames">) =>
  (decision.skillNames?.length
    ? decision.skillNames
    : decision.skillName
      ? [decision.skillName]
      : []
  ).map((name) => name.replace(/^managed:/, ""));

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
/** Dollars for a micro-dollar amount, keeping sub-cent charges visible. */
export const usd = (microUsd: number) => currency.format(microUsd / 1_000_000);

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");
// Savings are estimates at list prices; cents are as fine as they can honestly be read.
const dollars = (microUsd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    microUsd / 1_000_000,
  );
const threads = (count: number) => `${count} thread${count === 1 ? "" : "s"}`;

/**
 * What Auto's picks have been worth, as one headline and the lines behind it. Null until a pick
 * that changed a thread's model has been kept. The net takes off what stronger picks and Jev's
 * own judging cost, so it can be below zero, and says so.
 */
export function savingsSummary(savings: RoutingSavings | undefined) {
  if (!savings) return null;
  const { lighter, stronger, unpricedThreads, jevMicroUsd, since } = savings;
  if (lighter.threads + stronger.threads + unpricedThreads === 0) return null;
  const net = lighter.microUsd - stronger.microUsd - jevMicroUsd;
  const lines = [
    ...(lighter.threads > 0
      ? [
          `${threads(lighter.threads)} moved to a lighter model: ${whole.format(lighter.tokens)} tokens, ${dollars(lighter.microUsd)} less at list prices.`,
        ]
      : []),
    ...(stronger.threads > 0
      ? [
          `${threads(stronger.threads)} moved to a stronger model: ${whole.format(stronger.tokens)} tokens, ${dollars(stronger.microUsd)} more.`,
        ]
      : []),
    `Jev’s judging has cost ${dollars(jevMicroUsd)}.`,
    ...(unpricedThreads > 0
      ? [`${threads(unpricedThreads)} left out: one of the models has no known price.`]
      : []),
  ];
  return {
    headline: `${compact.format(lighter.tokens)} tokens on a lighter model · net ${net < 0 ? "−" : ""}${dollars(Math.abs(net))}`,
    lines,
    note: `Counted from picks you kept${since ? ` since ${new Date(since).toLocaleDateString()}` : ""}. Token counts are a floor, and prices are list prices, not what a subscription charges.`,
  };
}

export const pickSummary = (decision: RoutingDecision) =>
  `${decision.toModelName ?? decision.toModel}${decision.toEffort ? ` · ${decision.toEffort} effort` : ""}`;

/** One quiet line under a sent message saying what Auto chose for it. */
export function RoutedPickLine({ messageId }: { messageId: string }) {
  const decision = useRoutingPicks((state) => state.picks[messageId]);
  if (!decision) return null;
  const skills = attachedSkills(decision);
  return (
    <p data-wb-routed-pick="">
      {decision.applied ? "Auto" : "Auto would pick"} · {pickSummary(decision)}
      <span> · {judgedBy(decision)}</span>
      {skills.length > 0 && <span> · Skills: {skills.join(", ")}</span>}
      <span> — {decision.reason.replace(/^(?:Jev|Local rules|Last judgment): /, "")}</span>
    </p>
  );
}
