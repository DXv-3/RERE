import type { CampaignApprovalMode } from "@t3tools/contracts";

import { modeDescription, modeLabel } from "./campaigns.logic";

/**
 * Starting points for a campaign: each one turns two or three answers into a request to paste into
 * a thread with an agent. The request names the client, the campaign, the campaign tools the agent
 * should use, the client's brand notes and do-not-say list, and the approval mode in force, so the
 * agent starts with everything it needs and nothing here is sent on the person's behalf.
 */

export type TemplateId =
  | "weekly-reel-batch"
  | "blog-to-posts"
  | "monthly-calendar"
  | "long-video-to-shorts";

export interface TemplateField {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly kind: "text" | "number" | "month" | "url";
  readonly placeholder?: string;
  /** What the field starts as. */
  readonly initial: string;
  readonly required: boolean;
}

export interface CampaignTemplate {
  readonly id: TemplateId;
  readonly title: string;
  readonly summary: string;
  readonly fields: ReadonlyArray<TemplateField>;
}

export const CAMPAIGN_TEMPLATES: ReadonlyArray<CampaignTemplate> = [
  {
    id: "weekly-reel-batch",
    title: "Weekly Reel Batch",
    summary: "Short vertical videos for the week, cut from footage or made from a description.",
    fields: [
      {
        id: "count",
        label: "How Many Reels",
        hint: "A whole number from 1 to 10.",
        kind: "number",
        initial: "3",
        required: true,
      },
      {
        id: "source",
        label: "Footage Folder Or Theme",
        hint: "A folder in the thread's project, or a few words on what the reels should be about.",
        kind: "text",
        placeholder: "campaigns/launch/footage, or Behind the scenes at a wedding",
        initial: "",
        required: true,
      },
    ],
  },
  {
    id: "blog-to-posts",
    title: "Turn A Blog Post Into Five Posts",
    summary: "Five posts that each take one idea from an article.",
    fields: [
      {
        id: "url",
        label: "Blog Post Link",
        hint: "The address of the article, starting with https://.",
        kind: "url",
        placeholder: "https://",
        initial: "",
        required: true,
      },
      {
        id: "angle",
        label: "Angle Or Call To Action",
        hint: "Optional. What the posts should push people to do.",
        kind: "text",
        initial: "",
        required: false,
      },
    ],
  },
  {
    id: "monthly-calendar",
    title: "Monthly Campaign Calendar",
    summary: "A month of drafts with proposed dates, spread across the weeks.",
    fields: [
      {
        id: "month",
        label: "Month",
        hint: "The month to plan, like 2026-11.",
        kind: "month",
        initial: "",
        required: true,
      },
      {
        id: "perWeek",
        label: "Posts Per Week",
        hint: "A whole number from 1 to 7.",
        kind: "number",
        initial: "3",
        required: true,
      },
    ],
  },
  {
    id: "long-video-to-shorts",
    title: "Repurpose A Long Video Into Shorts",
    summary: "Short clips cut from one long video, each with a caption.",
    fields: [
      {
        id: "file",
        label: "Video File Path",
        hint: "A path inside the thread's project folder.",
        kind: "text",
        placeholder: "campaigns/launch/interview.mp4",
        initial: "",
        required: true,
      },
      {
        id: "count",
        label: "How Many Shorts",
        hint: "A whole number from 1 to 10.",
        kind: "number",
        initial: "3",
        required: true,
      },
    ],
  },
];

export const templateById = (id: TemplateId): CampaignTemplate =>
  CAMPAIGN_TEMPLATES.find((template) => template.id === id) ?? CAMPAIGN_TEMPLATES[0]!;

export const initialTemplateInputs = (template: CampaignTemplate): Record<string, string> =>
  Object.fromEntries(template.fields.map((field) => [field.id, field.initial]));

/** What a request needs to know about the campaign it is for. */
export interface TemplateContext {
  readonly clientId: string;
  readonly clientName: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly brandNotes: string;
  readonly doNotSay: ReadonlyArray<string>;
  readonly mode: CampaignApprovalMode;
}

export type TemplateResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problems: Readonly<Record<string, string>> };

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10" as "October 2026", or null when it is not a month. */
export function monthName(value: string): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  return match === null ? null : `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

const wholeNumber = (value: string, min: number, max: number): number | null => {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return number >= min && number <= max ? number : null;
};

const isWebAddress = (value: string): boolean => {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** A path in the thread's folder: not absolute, and no step up out of it. */
const isFolderPath = (value: string): boolean => {
  const text = value.trim();
  return (
    text !== "" &&
    !text.startsWith("/") &&
    !text.startsWith("\\") &&
    !/^[A-Za-z]:/.test(text) &&
    !text.split(/[\\/]/).includes("..")
  );
};

/** What is wrong with each field, by field id. Empty means the answers are usable. */
export function templateProblems(
  id: TemplateId,
  inputs: Readonly<Record<string, string>>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const value = (field: string) => (inputs[field] ?? "").trim();
  switch (id) {
    case "weekly-reel-batch":
      if (wholeNumber(value("count"), 1, 10) === null) {
        problems.count = "Use a whole number from 1 to 10.";
      }
      if (value("source") === "")
        problems.source = "Say where the footage is, or what the reels are about.";
      break;
    case "blog-to-posts":
      if (value("url") === "") problems.url = "Paste the link to the blog post.";
      else if (!isWebAddress(value("url"))) problems.url = "Links must start with https://.";
      break;
    case "monthly-calendar":
      if (monthName(value("month")) === null) problems.month = "Choose a month.";
      if (wholeNumber(value("perWeek"), 1, 7) === null) {
        problems.perWeek = "Use a whole number from 1 to 7.";
      }
      break;
    case "long-video-to-shorts":
      if (value("file") === "") problems.file = "Give the path to the video file.";
      else if (!isFolderPath(value("file"))) {
        problems.file =
          "Use a path inside the project folder, like campaigns/launch/interview.mp4.";
      }
      if (wholeNumber(value("count"), 1, 10) === null) {
        problems.count = "Use a whole number from 1 to 10.";
      }
      break;
  }
  return problems;
}

/** What the mode in force means for the agent, in an instruction. */
function modeInstruction(mode: CampaignApprovalMode): string {
  switch (mode) {
    case "ask-first":
      return "Save every post as a draft and submit it. Do not publish anything yourself: each post waits for an administrator to approve it.";
    case "report-when-done":
      return "Submit each post when it is ready. Submitted posts go out on schedule without a person approving each one, so check every caption first. When you finish, tell me exactly what you posted and when.";
    case "auto-publish":
      return "Submit each post when it is ready. Submitted posts go out on schedule and nobody approves each one, so check every caption and file before you submit. Only the publish log records what went out.";
  }
}

/** The part every request shares: who it is for, the rules, and the voice. */
function contextBlock(context: TemplateContext): string {
  const notes = context.brandNotes.trim();
  const phrases = context.doNotSay.map((phrase) => phrase.trim()).filter((phrase) => phrase !== "");
  return [
    `Client: ${context.clientName} (client id ${context.clientId})`,
    `Campaign: ${context.campaignName} (campaign id ${context.campaignId})`,
    `Approval mode in force: ${modeLabel(context.mode)}. ${modeDescription(context.mode)}`,
    "",
    `Brand notes for ${context.clientName}:`,
    notes === "" ? "None recorded. Ask me if you are unsure about the voice." : notes,
    "",
    "Do not say (no caption or title may contain any of these):",
    phrases.length === 0 ? "Nothing is listed." : phrases.map((phrase) => `- ${phrase}`).join("\n"),
  ].join("\n");
}

const TOOLS_SAVE_SUBMIT =
  "Use campaign_post_save to write each post as a draft (platforms, a caption for each platform, files, and a proposed time), then campaign_post_submit to send it for the mode above. Call campaign_list first to confirm the ids.";

/**
 * The request for one template: ready to paste into a thread with an agent. Returns the problems
 * with the answers instead when they cannot make a usable request.
 */
export function buildTemplateRequest(
  id: TemplateId,
  inputs: Readonly<Record<string, string>>,
  context: TemplateContext,
): TemplateResult {
  const problems = templateProblems(id, inputs);
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const value = (field: string) => (inputs[field] ?? "").trim();
  const forWhom = `for ${context.clientName}'s "${context.campaignName}" campaign`;
  let task: string;
  switch (id) {
    case "weekly-reel-batch": {
      const count = Number(value("count"));
      const source = value("source");
      task = [
        `Please make ${count} ${count === 1 ? "reel" : "reels"} ${forWhom} for this week.`,
        `Starting point: ${source}`,
        "",
        "How to do it:",
        "- If that is a folder, look at the footage with media_inspect first, then cut each reel with media_edit (vertical, 9:16, short).",
        "- If it is a theme, make the footage with media_generate_video, then look at the result with media_inspect.",
        `- ${TOOLS_SAVE_SUBMIT}`,
        "- Generation costs the client's money and may wait for an administrator's approval. Tell me the cost estimate each time, and say so if it is unknown.",
      ].join("\n");
      break;
    }
    case "blog-to-posts":
      task = [
        `Please turn this blog post into five posts ${forWhom}: ${value("url")}`,
        value("angle") === "" ? null : `Angle or call to action: ${value("angle")}`,
        "",
        "How to do it:",
        "- Read the article and pick five different ideas from it, one per post. Do not repeat a point.",
        "- Where a post needs a picture, use media_generate_image, or ask me for one. Look at each image with media_inspect before using it.",
        `- ${TOOLS_SAVE_SUBMIT}`,
        "- Link back to the article with the post's destination link where the platform allows it.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      break;
    case "monthly-calendar": {
      const month = monthName(value("month")) ?? value("month");
      task = [
        `Please plan ${month} ${forWhom}: ${Number(value("perWeek"))} posts a week, spread across the weeks.`,
        "",
        "How to do it:",
        "- Check what is already in the campaign first (campaign_post_list) so you do not repeat or collide with it.",
        `- Give every post a proposed time in ${month} and vary the days and the kinds of post.`,
        `- ${TOOLS_SAVE_SUBMIT}`,
        "- If a post needs a picture or video you do not have, say so in its caption draft and ask me, rather than leaving the post without one.",
      ].join("\n");
      break;
    }
    case "long-video-to-shorts": {
      const count = Number(value("count"));
      task = [
        `Please cut ${count} ${count === 1 ? "short" : "shorts"} from ${value("file")} ${forWhom}.`,
        "",
        "How to do it:",
        `- Watch the video with media_inspect and pick the ${count} strongest moments, each self-contained.`,
        "- Cut each one with media_edit as a vertical 9:16 clip, and look at the result with media_inspect.",
        `- ${TOOLS_SAVE_SUBMIT}`,
        "- Write a caption for each platform from what is said or shown in that clip, not from guesses.",
      ].join("\n");
      break;
    }
  }
  return {
    ok: true,
    text: `${task}\n\n${contextBlock(context)}\n\n${modeInstruction(context.mode)}`,
  };
}
