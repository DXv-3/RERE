import type { CampaignPost, ContentStudio, StudioAsset, StudioBrief } from "@t3tools/contracts";

type Scene = ContentStudio["scenes"][number];

export function moveStudioScene(
  scenes: readonly Scene[],
  id: string,
  offset: -1 | 1,
): readonly Scene[] {
  const index = scenes.findIndex((scene) => scene.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= scenes.length) return scenes;
  const next = [...scenes];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function duplicateStudioScene(
  scenes: readonly Scene[],
  id: string,
  newId: string,
): readonly Scene[] {
  const original = scenes.find((scene) => scene.id === id);
  if (!original) return scenes;
  const next = [...scenes];
  next.splice(scenes.indexOf(original) + 1, 0, {
    ...original,
    id: newId,
    title: `${original.title} copy`,
    selectedAssetId: null,
  });
  return next;
}

export function studioCalendarPosts(
  posts: readonly CampaignPost[],
  month: string,
  platform: string,
) {
  return posts
    .filter((post) => {
      if (
        platform !== "all" &&
        !post.platforms.includes(platform as CampaignPost["platforms"][number])
      )
        return false;
      if (!post.scheduledAt) return false;
      const date = new Date(post.scheduledAt);
      const localMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      return localMonth === month;
    })
    .toSorted((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
}

export function studioAssets(assets: ContentStudio["assets"], search: string, kind: string) {
  const query = search.trim().toLowerCase();
  return assets.filter(
    (asset) =>
      (kind === "all" || asset.kind === kind) &&
      [asset.file, asset.prompt, asset.model, asset.connector].some((value) =>
        value.toLowerCase().includes(query),
      ),
  );
}

export function studioDraftProblems(
  brief: ContentStudio["brief"],
  scenes: ContentStudio["scenes"],
) {
  const problems: string[] = [];
  if (brief.budgetUsd != null && (!Number.isFinite(brief.budgetUsd) || brief.budgetUsd < 0))
    problems.push("Campaign spending budget must be zero or greater.");
  if (
    !Number.isInteger(brief.durationSeconds) ||
    brief.durationSeconds < 15 ||
    brief.durationSeconds > 60
  )
    problems.push("Choose a target duration from 15 to 60 seconds.");
  if (
    scenes.some(
      (scene) =>
        !Number.isFinite(scene.durationSeconds) ||
        scene.durationSeconds < 1 ||
        scene.durationSeconds > 30,
    )
  )
    problems.push("Every scene needs a duration from 1 to 30 seconds.");
  if (
    scenes.some(
      (scene) =>
        scene.startSeconds !== undefined &&
        (!Number.isFinite(scene.startSeconds) || scene.startSeconds < 0),
    )
  )
    problems.push("Trim starts must be zero or greater.");
  if (
    scenes.some((scene) =>
      scene.captions?.some(
        (caption) =>
          !Number.isFinite(caption.start) ||
          !Number.isFinite(caption.end) ||
          caption.start < 0 ||
          caption.end <= caption.start ||
          caption.end > scene.durationSeconds,
      ),
    )
  )
    problems.push("Caption timing must fit within its scene, with end after start.");
  if (
    scenes.some(
      (scene) =>
        scene.allowanceUsd !== null &&
        (!Number.isFinite(scene.allowanceUsd) || scene.allowanceUsd < 0),
    )
  )
    problems.push("Spend allowances must be zero or greater.");
  const duration = scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (duration > 60) problems.push("The storyboard must be at most 60 seconds.");
  return problems;
}

/** Adds explicit campaign context to the existing composer; the person still sends it. */
export function studioAssistantPrompt(
  campaignId: string,
  campaignName: string,
  brief: ContentStudio["brief"],
  revise = false,
) {
  return `${revise ? "Help me revise" : "Help me plan"} the Content Studio for campaign ${JSON.stringify(campaignName)} (campaignId: ${JSON.stringify(campaignId)}).
Use campaign_studio_read to read its current saved Studio before editing, and campaign_studio_edit to save changes. Offer: ${brief.offer}. Audience: ${brief.audience}. Objective: ${brief.objective}.
Target ${brief.durationSeconds} seconds for ${brief.platforms.join(", ") || "platforms to be chosen"}. References: ${brief.references.join(", ") || "none yet"}.
Propose and save an editable storyboard, recommend supported providers and models with cost estimates or explicit unknown-price allowances, and explain the tradeoffs. Preserve existing work and use its latest revision. Prepare generation proposals only; wait for my explicit spend approval. Do not publish posts.`;
}

export const STORYBOARD_TEMPLATES = [
  {
    id: "product-demo",
    label: "Product demo",
    beats: [
      "Introduce the product",
      "Show it in use",
      "Show a useful detail",
      "Invite the next step",
    ],
  },
  {
    id: "testimonial",
    label: "Testimonial",
    beats: [
      "Introduce the customer",
      "Describe their challenge",
      "Add a verified customer quote",
      "Invite the next step",
    ],
  },
  {
    id: "offer",
    label: "Offer",
    beats: [
      "Introduce the offer",
      "Explain what is included",
      "Add verified terms",
      "Invite the next step",
    ],
  },
  {
    id: "before-after",
    label: "Before / after",
    beats: [
      "Show the starting point",
      "Show the process",
      "Show the documented result",
      "Invite the next step",
    ],
  },
] as const;

/** Local proposals deliberately carry no model, spend allowance, or generated asset. */
export function storyboardTemplateScenes(
  templateId: (typeof STORYBOARD_TEMPLATES)[number]["id"],
  brief: StudioBrief,
  brandNotes: string,
  newId: () => string,
): readonly Scene[] {
  const template = STORYBOARD_TEMPLATES.find((value) => value.id === templateId)!;
  const duration = Number.isInteger(brief.durationSeconds)
    ? Math.max(15, Math.min(60, brief.durationSeconds))
    : 30;
  const base = Math.floor(duration / template.beats.length);
  return template.beats.map((beat, index) => ({
    id: newId(),
    title: beat,
    durationSeconds: base + (index < duration % template.beats.length ? 1 : 0),
    prompt: [
      beat,
      `Product / offer: ${brief.offer}`,
      `Audience: ${brief.audience}`,
      `Objective: ${brief.objective}`,
      brandNotes ? `Saved brand notes: ${brandNotes}` : "",
      brief.references.length ? `References: ${brief.references.join(", ")}` : "",
      "Use only verified claims and approved reference material.",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000),
    referenceImage: null,
    narration:
      templateId === "testimonial" && index === 2
        ? "[Insert an approved, verbatim customer quote.]"
        : `[Write narration: ${beat.toLowerCase()}.]`,
    onScreenText: index === 0 ? brief.offer.slice(0, 200) : "",
    selectedAssetId: null,
    connector: "",
    model: "",
    resolution: "720p",
    generateAudio: false,
    allowanceUsd: null,
  }));
}

export function studioSceneVariants(assets: readonly StudioAsset[], sceneId: string) {
  return assets.filter(
    (asset) => asset.kind !== "audio" && (asset.sceneId === sceneId || asset.sceneId === null),
  );
}

export function studioUploadKind(file: Pick<File, "name" | "type">): StudioAsset["kind"] | null {
  // Match the server media allowlist; never infer a workspace path from a browser filename.
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension ?? "")) return "image";
  if (["mp4", "mov", "webm", "m4v"].includes(extension ?? "")) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(extension ?? "")) return "audio";
  return null;
}
