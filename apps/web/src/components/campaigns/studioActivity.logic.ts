import type { CampaignGenerationJob, ContentStudio, StudioBudget } from "@t3tools/contracts";

const usd = (value: number) => `$${value.toFixed(2)}`;
export function studioBudgetPresentation(budget: StudioBudget | undefined) {
  return {
    amounts: [
      {
        label: "Campaign budget",
        value: budget
          ? budget.budgetUsd === null
            ? "Not set"
            : usd(budget.budgetUsd)
          : "Unavailable",
      },
      {
        label: "Available budget",
        value: budget
          ? budget.availableUsd === null
            ? "Not set"
            : usd(budget.availableUsd)
          : "Unavailable",
      },
      { label: "Reserved spend", value: budget ? usd(budget.reservedUsd) : "Unavailable" },
      {
        label: "Confirmed charges",
        value: budget?.confirmedUsd == null ? "Unreported" : usd(budget.confirmedUsd),
      },
    ],
    note: `Campaign totals cover all time; the client monthly cap also applies. Reservations include estimates and approved allowances, not confirmed charges.${budget?.unreportedCount ? ` Actual charges for ${budget.unreportedCount} submitted request(s) are unknown or unreported.` : ""}`,
    alert: budget?.unresolvedSubmissions
      ? `${budget.unresolvedSubmissions} provider submission(s) need reconciliation. Their reservations remain held; check existing provider requests before approving new spend.`
      : null,
  };
}

export function studioActivity(studio: ContentStudio, jobs: readonly CampaignGenerationJob[]) {
  const generation = jobs.filter(
    (job) =>
      job.campaignId === studio.campaignId ||
      studio.generationLinks.some((link) => link.jobId === job.id),
  );
  return [
    ...generation.map((job) => ({
      kind: "generation" as const,
      id: job.id,
      at: job.updatedAt,
      unresolved: job.submissionState === "uncertain",
      job,
    })),
    ...(studio.narrations ?? []).map((job) => ({
      kind: "narration" as const,
      id: job.id,
      at: job.updatedAt,
      unresolved: job.status === "uncertain",
      job,
    })),
    ...studio.renders.map((job) => ({
      kind: "render" as const,
      id: job.id,
      at: job.createdAt,
      unresolved: false,
      job,
    })),
  ].sort(
    (a, b) =>
      Number(b.unresolved) - Number(a.unresolved) ||
      b.at.localeCompare(a.at) ||
      a.id.localeCompare(b.id),
  );
}
