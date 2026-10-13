import type { StudioBudget } from "@t3tools/contracts";
import { studioBudgetPresentation } from "./studioActivity.logic";

export function CampaignStudioBudget({ budget }: { readonly budget: StudioBudget | undefined }) {
  const view = studioBudgetPresentation(budget);
  return (
    <section aria-label="Campaign budget" className="space-y-2 rounded-lg border border-border p-3">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {view.amounts.map(({ label, value }) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{view.note}</p>
      {view.alert && (
        <p role="alert" className="text-sm font-medium">
          {view.alert}
        </p>
      )}
    </section>
  );
}
