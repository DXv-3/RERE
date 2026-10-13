import type { CampaignClient, CampaignPost } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalLine,
  availablePostActions,
  campaignFailureMessage,
  canEditPost,
  captionExcerpt,
  cardSummary,
  cardSummaryLine,
  confirmationText,
  draftRequestText,
  formatPostTime,
  formIsChanged,
  formToSaveInput,
  groupPostsByColumn,
  isoToLocalInput,
  localInputToIso,
  modeChangeConfirmation,
  modeInForce,
  needsApprovalCount,
  parseDoNotSay,
  parseMediaEntry,
  parseSpendCap,
  postProblems,
  postToForm,
} from "./campaigns.logic";

const at = "2026-10-06T12:00:00.000Z";

function post(overrides: Partial<CampaignPost> = {}): CampaignPost {
  return {
    id: "post-1",
    campaignId: "campaign-1",
    status: "draft",
    platforms: ["instagram"],
    captions: { default: "A caption", byPlatform: {} },
    mediaPaths: ["campaigns/reel.mp4"],
    mediaUrls: [],
    uploadedMedia: {},
    createdBy: { kind: "person" },
    approval: null,
    publishResults: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const client: CampaignClient = {
  id: "client-1",
  name: "Candid Studios",
  brandNotes: "",
  doNotSay: ["cheap"],
  approvalMode: "ask-first",
  createdAt: at,
  updatedAt: at,
};

describe("groupPostsByColumn", () => {
  it("puts each status in its column and keeps rejected posts apart", () => {
    const groups = groupPostsByColumn([
      post({ id: "a", status: "draft" }),
      post({ id: "b", status: "needs-approval" }),
      post({ id: "c", status: "approved" }),
      post({ id: "d", status: "scheduled" }),
      post({ id: "e", status: "posted" }),
      post({ id: "f", status: "failed" }),
      post({ id: "g", status: "rejected" }),
      post({ id: "h", status: "publishing" }),
    ]);
    expect(groups.columns.map((column) => column.label)).toEqual([
      "Draft",
      "Needs Approval",
      "Approved",
      "Scheduled",
      "Posted",
      "Failed",
    ]);
    const ids = Object.fromEntries(
      groups.columns.map((column) => [column.status, column.posts.map((p) => p.id)]),
    );
    expect(ids).toMatchObject({
      draft: ["a"],
      "needs-approval": ["b"],
      approved: ["c"],
      posted: ["e"],
      failed: ["f"],
    });
    // A post being sent right now sits with Scheduled.
    expect(ids["scheduled"]?.toSorted()).toEqual(["d", "h"]);
    expect(groups.rejected.map((p) => p.id)).toEqual(["g"]);
  });

  it("orders scheduled posts by time with untimed ones last, others newest first", () => {
    const groups = groupPostsByColumn([
      post({ id: "late", status: "scheduled", scheduledAt: "2026-10-09T09:00:00.000Z" }),
      post({ id: "none", status: "scheduled" }),
      post({ id: "soon", status: "scheduled", scheduledAt: "2026-10-07T09:00:00.000Z" }),
      post({ id: "old", status: "draft", updatedAt: "2026-10-01T00:00:00.000Z" }),
      post({ id: "new", status: "draft", updatedAt: "2026-10-05T00:00:00.000Z" }),
    ]);
    const column = (status: string) =>
      groups.columns.find((c) => c.status === status)?.posts.map((p) => p.id);
    expect(column("scheduled")).toEqual(["soon", "late", "none"]);
    expect(column("draft")).toEqual(["new", "old"]);
  });
});

describe("formatPostTime", () => {
  const now = new Date("2026-10-06T15:00:00.000Z");
  const opts = { timeZone: "UTC", locale: "en-US" };
  it("says today, tomorrow and yesterday", () => {
    expect(formatPostTime("2026-10-06T18:30:00.000Z", now, opts)).toBe("Today 6:30 PM");
    expect(formatPostTime("2026-10-07T09:00:00.000Z", now, opts)).toBe("Tomorrow 9:00 AM");
    expect(formatPostTime("2026-10-05T09:00:00.000Z", now, opts)).toBe("Yesterday 9:00 AM");
  });
  it("names the weekday inside the next week and the date after that", () => {
    expect(formatPostTime("2026-10-09T14:00:00.000Z", now, opts)).toBe("Friday 2:00 PM");
    expect(formatPostTime("2026-10-21T09:00:00.000Z", now, opts)).toBe("Oct 21, 9:00 AM");
    expect(formatPostTime("2027-01-02T09:00:00.000Z", now, opts)).toBe("Jan 2, 2027, 9:00 AM");
  });
  it("uses the day in the given zone, not UTC", () => {
    // 02:00 UTC on the 7th is still the 6th in Los Angeles.
    expect(
      formatPostTime("2026-10-07T02:00:00.000Z", now, { ...opts, timeZone: "America/Los_Angeles" }),
    ).toBe("Today 7:00 PM");
  });
  it("returns null for no time or a bad one", () => {
    expect(formatPostTime(undefined, now, opts)).toBeNull();
    expect(formatPostTime("nonsense", now, opts)).toBeNull();
  });
});

describe("local time inputs", () => {
  it("round-trips a time through the datetime-local value", () => {
    const iso = "2026-10-07T09:30:00.000Z";
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });
  it("treats empty and invalid input as no time", () => {
    expect(isoToLocalInput(undefined)).toBe("");
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("not a time")).toBeNull();
  });
});

describe("availablePostActions", () => {
  const names = (status: CampaignPost["status"], isAdministrator: boolean, mode = "ask-first") =>
    availablePostActions(
      { status },
      { isAdministrator, mode: mode as "ask-first", problems: [] },
    ).map((a) => `${a.action}:${a.enabled}`);

  it("offers a draft Submit to anyone under Ask Me First and Approve to administrators", () => {
    expect(names("draft", false)).toEqual(["submit:true", "approve:false", "delete:false"]);
    expect(names("draft", true)).toEqual(["submit:true", "approve:true", "delete:true"]);
  });

  it("offers each status only what the server accepts", () => {
    expect(names("needs-approval", true)).toEqual([
      "approve:true",
      "requestChanges:true",
      "reject:true",
      "publishNow:true",
      "delete:true",
    ]);
    expect(names("failed", true)).toEqual([
      "retry:true",
      "requestChanges:true",
      "reject:true",
      "delete:true",
    ]);
    expect(names("publishing", true)).toEqual([]);
    expect(names("posted", true)).toEqual(["delete:true"]);
    expect(names("rejected", true)).toEqual(["delete:true"]);
  });

  it("never enables approving, publishing or retrying for a non-administrator", () => {
    for (const status of ["needs-approval", "approved", "scheduled", "failed"] as const) {
      const actions = availablePostActions(
        { status },
        { isAdministrator: false, mode: "ask-first" },
      );
      expect(actions.every((a) => !a.enabled)).toBe(true);
      expect(actions[0]?.reason).toContain("administrator");
    }
  });

  it("holds a person's Submit back where it would publish without approval", () => {
    const submit = availablePostActions(
      { status: "draft" },
      { isAdministrator: false, mode: "auto-publish" },
    )[0];
    expect(submit).toMatchObject({ action: "submit", enabled: false });
    expect(submit?.reason).toContain("publishes on its own");
    const admin = availablePostActions(
      { status: "draft" },
      { isAdministrator: true, mode: "auto-publish" },
    )[0];
    expect(admin?.enabled).toBe(true);
  });

  it("turns off Submit, Approve and Publish Now while there are problems", () => {
    const actions = availablePostActions(
      { status: "needs-approval" },
      { isAdministrator: true, mode: "ask-first", problems: ["Choose at least one platform."] },
    );
    const by = (name: string) => actions.find((a) => a.action === name);
    expect(by("approve")).toMatchObject({
      enabled: false,
      reason: "Fix the problems listed first.",
    });
    expect(by("publishNow")?.enabled).toBe(false);
    expect(by("reject")?.enabled).toBe(true);
  });

  it("marks reject and delete destructive and publish, reject and delete as confirmed", () => {
    const actions = availablePostActions(
      { status: "needs-approval" },
      { isAdministrator: true, mode: "ask-first" },
    );
    const by = (name: string) => actions.find((a) => a.action === name);
    expect(by("delete")).toMatchObject({ destructive: true, confirm: true });
    expect(by("reject")).toMatchObject({ destructive: true, confirm: true });
    expect(by("publishNow")).toMatchObject({ destructive: false, confirm: true });
    expect(by("approve")?.confirm).toBe(false);
    expect(confirmationText("approve", "ask-first", "export")).toBeNull();
    expect(confirmationText("delete", "ask-first", "export")?.confirmLabel).toBe("Delete");
  });
});

describe("canEditPost", () => {
  it("allows editing only while Draft or Needs Approval", () => {
    expect(canEditPost("draft")).toBe(true);
    expect(canEditPost("needs-approval")).toBe(true);
    for (const status of [
      "approved",
      "scheduled",
      "publishing",
      "posted",
      "failed",
      "rejected",
    ] as const) {
      expect(canEditPost(status)).toBe(false);
    }
  });
});

describe("card summary", () => {
  const now = new Date("2026-10-06T15:00:00.000Z");
  it("trims a long caption to one line", () => {
    const long = "word ".repeat(100);
    const excerpt = captionExcerpt(post({ captions: { default: long, byPlatform: {} } }));
    expect(excerpt.length).toBeLessThanOrEqual(120);
    expect(excerpt.endsWith("…")).toBe(true);
  });
  it("falls back to the first platform's own caption", () => {
    expect(
      captionExcerpt(post({ captions: { default: "", byPlatform: { instagram: "Own words" } } })),
    ).toBe("Own words");
  });
  it("words who approved a post and shows it only once it is approved", () => {
    expect(approvalLine({ by: "person", at })).toBe("Approved by a person");
    expect(approvalLine({ by: "mode", mode: "auto-publish", at })).toBe(
      "Approved by the Auto Publish setting",
    );
    expect(approvalLine(null)).toBeNull();
    expect(
      cardSummary(post({ status: "draft", approval: { by: "person", at } }), now).approval,
    ).toBeNull();
    expect(
      cardSummary(post({ status: "scheduled", approval: { by: "person", at } }), now).approval,
    ).toBe("Approved by a person");
  });
  it("builds the line under the caption", () => {
    const summary = cardSummary(
      post({
        platforms: ["instagram", "gbp"],
        mediaPaths: ["a.png"],
        mediaUrls: ["https://example.com/b.png"],
        createdBy: { kind: "agent", threadId: "thread-1" as never },
      }),
      now,
    );
    expect(summary.creator).toBe("Drafted by an agent");
    expect(cardSummaryLine({ ...summary, time: "Tomorrow 9:00 AM" })).toBe(
      "Instagram, Google · 2 files · Tomorrow 9:00 AM",
    );
    expect(cardSummaryLine({ ...summary, platforms: [], mediaCount: 0, time: null })).toBe(
      "No platform yet",
    );
  });
  it("counts posts waiting for approval", () => {
    expect(needsApprovalCount({ postCounts: { "needs-approval": 3, draft: 2 } })).toBe(3);
    expect(needsApprovalCount({ postCounts: {} })).toBe(0);
  });
});

describe("modes", () => {
  it("uses the campaign's own mode over the client's", () => {
    expect(modeInForce(client, { approvalMode: undefined })).toEqual({
      mode: "ask-first",
      overridden: false,
    });
    expect(modeInForce(client, { approvalMode: "auto-publish" })).toEqual({
      mode: "auto-publish",
      overridden: true,
    });
  });
  it("asks for confirmation only for the modes that publish without asking", () => {
    expect(modeChangeConfirmation("ask-first", { kind: "campaign", name: "Spring" })).toBeNull();
    const confirm = modeChangeConfirmation("auto-publish", {
      kind: "client",
      name: "Candid Studios",
    });
    expect(confirm?.title).toBe("Switch To Auto Publish?");
    expect(confirm?.body).toContain("all of Candid Studios's campaigns");
    expect(confirm?.body).toContain("Nobody will be asked first");
    expect(
      modeChangeConfirmation("report-when-done", { kind: "campaign", name: "Spring" })?.body,
    ).toContain("tell you what it posted");
  });
});

describe("postProblems", () => {
  it("names platforms the way people do and checks the do-not-say list", () => {
    const problems = postProblems(
      post({
        platforms: ["instagram"],
        mediaPaths: [],
        captions: { default: "so cheap", byPlatform: {} },
      }),
      client,
    );
    expect(problems).toContain("Instagram needs at least one image or video.");
    expect(problems.some((p) => p.includes('"cheap"'))).toBe(true);
  });
  it("is empty for a ready post", () => {
    expect(postProblems(post(), client)).toEqual([]);
  });
});

describe("campaignFailureMessage", () => {
  it("words an authorization failure plainly", () => {
    expect(
      campaignFailureMessage({
        _tag: "EnvironmentAuthorizationError",
        message: "Missing scope access:write",
        requiredScope: "access:write",
      }),
    ).toContain("Only an administrator can do this");
  });
  it("shows the server's own sentence for refusals", () => {
    expect(
      campaignFailureMessage({
        _tag: "CampaignError",
        reason: "invalid",
        message: "This post is not ready: Choose at least one platform.",
      }),
    ).toBe("This post is not ready: Choose at least one platform.");
    expect(
      campaignFailureMessage({ _tag: "CampaignError", reason: "storage", message: "sqlite busy" }),
    ).toBe("The server could not save this. Try again.");
  });
  it("does not leak technical text for anything else", () => {
    expect(campaignFailureMessage(new Error("ECONNRESET at socket"))).toBe(
      "Could not reach campaigns. Check your connection and try again.",
    );
    expect(
      campaignFailureMessage({ _tag: "EnvironmentRpcUnavailableError", message: "x" }),
    ).toContain("not connected");
    expect(campaignFailureMessage(null)).toContain("Could not reach campaigns");
  });
});

describe("form helpers", () => {
  it("parses one phrase per line without blanks or repeats", () => {
    expect(parseDoNotSay(" cheap \n\nCheap\nbest price\r\nfree")).toEqual([
      "cheap",
      "best price",
      "free",
    ]);
  });
  it("reads a spend cap", () => {
    expect(parseSpendCap("")).toEqual({ ok: true, value: null });
    expect(parseSpendCap("$50")).toEqual({ ok: true, value: 50 });
    expect(parseSpendCap("-1")).toEqual({ ok: false });
    expect(parseSpendCap("lots")).toEqual({ ok: false });
  });
  it("tells links from paths and refuses paths outside the folder", () => {
    expect(parseMediaEntry("https://example.com/a.png")).toEqual({
      kind: "url",
      value: "https://example.com/a.png",
    });
    expect(parseMediaEntry(" campaigns/a.mp4 ")).toEqual({
      kind: "path",
      value: "campaigns/a.mp4",
    });
    expect(parseMediaEntry("/etc/passwd").kind).toBe("invalid");
    expect(parseMediaEntry("../a.png").kind).toBe("invalid");
    expect(parseMediaEntry("C:\\a.png").kind).toBe("invalid");
    expect(parseMediaEntry("ftp://example.com/a.png").kind).toBe("invalid");
    expect(parseMediaEntry("").kind).toBe("invalid");
  });
  it("builds a save call that clears empty optional fields", () => {
    const saved = post({ title: "Old", scheduledAt: "2026-10-07T09:00:00.000Z" });
    const form = { ...postToForm(saved), title: "", scheduledAt: "" };
    expect(formToSaveInput(form, { campaignId: "campaign-1", postId: "post-1" })).toMatchObject({
      id: "post-1",
      campaignId: "campaign-1",
      title: null,
      destinationUrl: null,
      scheduledAt: null,
    });
    expect(formToSaveInput(postToForm(saved), { campaignId: "campaign-1" }).id).toBeUndefined();
  });
  it("drops captions for platforms that were unticked and detects real changes", () => {
    const saved = post({ platforms: ["instagram", "facebook"] });
    const form = {
      ...postToForm(saved),
      platforms: ["instagram" as const],
      platformCaptions: { facebook: "Facebook only", instagram: "Own" },
    };
    expect(formToSaveInput(form, { campaignId: "c" }).captions.byPlatform).toEqual({
      instagram: "Own",
    });
    expect(formIsChanged(postToForm(saved), saved)).toBe(false);
    expect(formIsChanged(form, saved)).toBe(true);
  });
  it("asks an agent by naming the client and campaign", () => {
    expect(draftRequestText("Candid Studios", "Fall Minis")).toContain(
      '"Fall Minis" campaign for Candid Studios',
    );
  });
  it("sends a thread only for a new post that names one", () => {
    const form = postToForm(post());
    expect(formToSaveInput(form, { campaignId: "c" }).sourceThreadId).toBeUndefined();
    expect(
      formToSaveInput(form, { campaignId: "c", sourceThreadId: "thread-9" }).sourceThreadId,
    ).toBe("thread-9");
  });
});
