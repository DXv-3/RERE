import { describe, expect, it } from "vite-plus/test";

import {
  CAMPAIGN_TEMPLATES,
  buildTemplateRequest,
  initialTemplateInputs,
  monthName,
  templateById,
  templateProblems,
  type TemplateContext,
  type TemplateId,
} from "./campaignTemplates.logic";

const context = (patch: Partial<TemplateContext> = {}): TemplateContext => ({
  clientId: "client-1",
  clientName: "Candid Studios",
  campaignId: "campaign-1",
  campaignName: "Fall Weddings",
  brandNotes: "Warm, honest, never salesy.",
  doNotSay: ["cheap", "best in the world"],
  mode: "ask-first",
  ...patch,
});

const GOOD: Record<TemplateId, Record<string, string>> = {
  "weekly-reel-batch": { count: "3", source: "campaigns/fall/footage" },
  "blog-to-posts": { url: "https://candidstudios.net/blog/venues", angle: "Book a call" },
  "monthly-calendar": { month: "2026-11", perWeek: "3" },
  "long-video-to-shorts": { file: "campaigns/fall/interview.mp4", count: "4" },
};

describe("templates", () => {
  it("offers the four starting points under their titles", () => {
    expect(CAMPAIGN_TEMPLATES.map((template) => template.title)).toEqual([
      "Weekly Reel Batch",
      "Turn A Blog Post Into Five Posts",
      "Monthly Campaign Calendar",
      "Repurpose A Long Video Into Shorts",
    ]);
    for (const template of CAMPAIGN_TEMPLATES) {
      expect(template.fields.length).toBeGreaterThanOrEqual(2);
      expect(template.fields.length).toBeLessThanOrEqual(3);
    }
  });

  it("starts each form from its field defaults", () => {
    expect(initialTemplateInputs(templateById("weekly-reel-batch"))).toEqual({
      count: "3",
      source: "",
    });
  });
});

describe("buildTemplateRequest", () => {
  it.each(Object.keys(GOOD) as TemplateId[])(
    "%s names the client, campaign, brand notes, do-not-say list and mode",
    (id) => {
      const result = buildTemplateRequest(id, GOOD[id]!, context());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toContain("Candid Studios");
      expect(result.text).toContain("Fall Weddings");
      expect(result.text).toContain("client-1");
      expect(result.text).toContain("campaign-1");
      expect(result.text).toContain("Warm, honest, never salesy.");
      expect(result.text).toContain("- cheap");
      expect(result.text).toContain("- best in the world");
      expect(result.text).toContain("Ask Me First");
      expect(result.text).toContain("campaign_post_save");
      expect(result.text).toContain("campaign_post_submit");
      expect(result.text).not.toContain("—");
    },
  );

  it("names the media tools each template needs", () => {
    const text = (id: TemplateId) => {
      const result = buildTemplateRequest(id, GOOD[id]!, context());
      return result.ok ? result.text : "";
    };
    expect(text("weekly-reel-batch")).toContain("media_inspect");
    expect(text("weekly-reel-batch")).toContain("media_edit");
    expect(text("weekly-reel-batch")).toContain("media_generate_video");
    expect(text("blog-to-posts")).toContain("media_generate_image");
    expect(text("blog-to-posts")).toContain("https://candidstudios.net/blog/venues");
    expect(text("monthly-calendar")).toContain("November 2026");
    expect(text("monthly-calendar")).toContain("campaign_post_list");
    expect(text("long-video-to-shorts")).toContain("campaigns/fall/interview.mp4");
    expect(text("long-video-to-shorts")).toContain("media_edit");
  });

  it("keeps the exact brand names", () => {
    for (const name of ["Candid Studios", "Savage Digital Solutions"]) {
      const result = buildTemplateRequest(
        "blog-to-posts",
        GOOD["blog-to-posts"]!,
        context({ clientName: name }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toContain(`Client: ${name} (`);
      expect(result.text).toContain(`for ${name}'s "Fall Weddings" campaign`);
      // Never shortened to the names the brand rules forbid.
      expect(result.text).not.toMatch(/Candid Studio(?!s)/);
      expect(result.text).not.toMatch(/Savage Solutions|Savage Digital(?! Solutions)/);
    }
  });

  it("states the approval mode in force for each mode", () => {
    const text = (mode: TemplateContext["mode"]) => {
      const result = buildTemplateRequest(
        "monthly-calendar",
        GOOD["monthly-calendar"]!,
        context({ mode }),
      );
      return result.ok ? result.text : "";
    };
    expect(text("ask-first")).toContain("Ask Me First");
    expect(text("ask-first")).toContain("waits for an administrator");
    expect(text("report-when-done")).toContain("Report When Done");
    expect(text("report-when-done")).toContain("tell me exactly what you posted");
    expect(text("auto-publish")).toContain("Auto Publish");
    expect(text("auto-publish")).toContain("nobody approves each one");
  });

  it("says so when there are no brand notes or phrases", () => {
    const result = buildTemplateRequest(
      "weekly-reel-batch",
      GOOD["weekly-reel-batch"]!,
      context({ brandNotes: "  ", doNotSay: [] }),
    );
    expect(result.ok && result.text).toContain("None recorded.");
    expect(result.ok && result.text).toContain("Nothing is listed.");
  });

  it("returns problems instead of a request for bad answers", () => {
    const result = buildTemplateRequest("blog-to-posts", { url: "ftp://x", angle: "" }, context());
    expect(result).toEqual({ ok: false, problems: { url: "Links must start with https://." } });
  });
});

describe("templateProblems", () => {
  it("checks counts, links, months and folder paths", () => {
    expect(templateProblems("weekly-reel-batch", { count: "0", source: "" })).toEqual({
      count: "Use a whole number from 1 to 10.",
      source: "Say where the footage is, or what the reels are about.",
    });
    expect(templateProblems("blog-to-posts", { url: "", angle: "" }).url).toBeDefined();
    expect(templateProblems("monthly-calendar", { month: "", perWeek: "8" })).toHaveProperty(
      "month",
    );
    expect(templateProblems("monthly-calendar", { month: "2026-13", perWeek: "3" })).toHaveProperty(
      "month",
    );
    expect(
      templateProblems("long-video-to-shorts", { file: "/etc/x.mp4", count: "3" }),
    ).toHaveProperty("file");
    expect(
      templateProblems("long-video-to-shorts", { file: "../x.mp4", count: "3" }),
    ).toHaveProperty("file");
    expect(templateProblems("long-video-to-shorts", { file: "a/b.mp4", count: "3" })).toEqual({});
  });

  it("names a month", () => {
    expect(monthName("2026-10")).toBe("October 2026");
    expect(monthName("nope")).toBeNull();
  });
});
