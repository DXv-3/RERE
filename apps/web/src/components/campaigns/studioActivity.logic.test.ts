import { describe, expect, it } from "vite-plus/test";
import type { ContentStudio } from "@t3tools/contracts";
import { studioActivity, studioBudgetPresentation } from "./studioActivity.logic";

describe("studio budget presentation", () => {
  it("does not present allowances or unknown actuals as confirmed charges", () => {
    const view = studioBudgetPresentation({
      budgetUsd: 10,
      availableUsd: 3,
      reservedUsd: 7,
      confirmedUsd: null,
      unreportedCount: 2,
      unresolvedSubmissions: 1,
    });
    expect(view.amounts).toEqual([
      { label: "Campaign budget", value: "$10.00" },
      { label: "Available budget", value: "$3.00" },
      { label: "Reserved spend", value: "$7.00" },
      { label: "Confirmed charges", value: "Unreported" },
    ]);
    expect(view.alert).toContain("reservations remain held");
    expect(view.note).toContain("2 submitted request(s) are unknown or unreported");
  });
  it("distinguishes missing budget data, uncapped campaigns, and evidenced zero charges", () => {
    expect(studioBudgetPresentation(undefined).amounts[1]?.value).toBe("Unavailable");
    const view = studioBudgetPresentation({
      budgetUsd: null,
      availableUsd: null,
      reservedUsd: 0,
      confirmedUsd: 0,
      unreportedCount: 0,
      unresolvedSubmissions: 0,
    });
    expect(view.amounts[1]?.value).toBe("Not set");
    expect(view.amounts[3]?.value).toBe("$0.00");
    expect(view.alert).toBeNull();
  });
  it("keeps unresolved paid attempts above newer completed renders", () => {
    const studio = {
      campaignId: "c",
      generationLinks: [],
      narrations: [{ id: "n", status: "uncertain", updatedAt: "2026-01-01T00:00:00Z" }],
      renders: [{ id: "r", status: "completed", createdAt: "2026-10-01T00:00:00Z" }],
    } as unknown as ContentStudio;
    expect(studioActivity(studio, []).map((item) => item.id)).toEqual(["n", "r"]);
  });
});
