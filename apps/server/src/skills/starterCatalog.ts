import type { ManagedSkillManifest } from "@t3tools/contracts";

// Reviewed, self-contained adaptations; original source hashes identify the review input.
// Bundled instructions are admitted only on administrator request and start disabled.
export const starterCatalog = [
  {
    id: "reel-review",
    name: "Reel Review",
    description:
      "Review video reels, captions, hooks and visual quality without editing footage or publishing.",
    source: "local-source:reel-watch/SKILL.md",
    sourceRevision: "local-reviewed-2026-10-03",
    sourceSha256: "812ccd057247d90dca2ccebe2de7d79c8162d1dc39968ea857616c34ece03e8f",
    reviewNote:
      "Reviewed local reel-watch instructions. Adapted into plan/review stages for any company; removed the unconditional Slack/email delivery instruction and the machine-specific tool and library paths. No publishing, messaging, generation or source-media edits are authorized by this skill.",
    permissions: [
      "Read user-supplied media and any reference library the task names",
      "Run an already installed frame extractor only for an authorized supplied asset",
    ],
    projectRoots: [],
    dependencies: [],
    stages: [
      {
        stage: "plan",
        instructions:
          "Clarify the supplied reel asset, company, audience and campaign goal. Ask which reel reference library or brand guide applies to that company and use only that one; never apply one company's guide to another. Plan a perception-only review. Do not alter footage, generate imagery, publish, unpause a campaign or send messages. Identify missing assets or dependencies before proceeding.",
      },
      {
        stage: "review",
        instructions:
          "Review only the media asset authorized for this task. If frame extraction is needed and authorized, use a frame extractor that is already installed (for example ffmpeg) on the supplied asset path; do not install tools automatically. Read every extracted frame, including t=0, first second, body and last two seconds. Check opening action, hook length and safe placement, pacing, visual peak, closing card, aspect ratio, resolution, codec and duration. When the task names a reference library, compare the relevant angle in it. Use transcripts when speech is present; music-only audio is not a failure. Return what works, a concrete change list, source references and remaining uncertainty in this chat. Do not edit source footage, burn captions, generate imagery, publish, unpause campaigns or send Slack/email messages without separate task authorization.",
      },
    ],
  },
  {
    id: "focused-code-change",
    name: "Focused Code Change",
    description:
      "Plan a scoped code bug fix or refactor with verifiable regression tests and minimal changes.",
    source: "local-source:karpathy-guidelines/SKILL.md",
    sourceRevision: "local-reviewed-2026-10-03",
    sourceSha256: "147d87359c3e077be69472e91fc4d5a8c491ec2de0277bf181a83572e03eb201",
    reviewNote:
      "Reviewed all four guideline sections. Adapted into bounded plan and verify stages; no execution, publishing, installing, or environment changes are authorized by this entry.",
    permissions: [
      "Read task-authorized source material",
      "Run focused checks only when already authorized by the task",
    ],
    projectRoots: [],
    dependencies: [],
    stages: [
      {
        stage: "plan",
        instructions:
          "Read the requested behavior, applicable repository instructions and relevant code. State any assumption that changes the implementation. Define a concrete success check, including a reproducer for a reported bug. Choose the smallest change that satisfies the request and preserves unrelated work. Prefer existing patterns; do not add speculative abstractions or configuration. Ask only for missing information that prevents a correct change. This stage produces a scoped plan; it does not run commands or edit files.",
      },
      {
        stage: "verify",
        instructions:
          "Compare the actual diff with the requested behavior and repository instructions. Identify unnecessary changes, unhandled real failure paths and unsupported claims. If the task authorizes running checks, run only relevant tests and required scoped checks; preserve failures and their evidence. Do not delete unrelated code or change global configuration to make checks pass. Report exactly which behavior was verified, what remains untested and whether an actual deployed or installed workflow was accepted. This skill does not authorize commits, deployment or external messages.",
      },
    ],
  },
  {
    id: "knowledge-audit",
    name: "Knowledge Audit",
    description:
      "Audit an Obsidian knowledge base wiki for missing notes, broken links, stale claims and documentation gaps.",
    source: "local-source:kb-learn/SKILL.md",
    sourceRevision: "local-reviewed-2026-10-03",
    sourceSha256: "fc21f857ed483d25dc842ccf13220fbc016caec00dfd5be9ea41a3622349082e",
    reviewNote:
      "Reviewed purpose and lint Steps 1-3 only. This is a read-only audit adaptation; excluded upstream research, ingestion, index rebuild, commits and synchronization. Age is a review signal, not proof a claim is false.",
    permissions: ["Read task-authorized source material"],
    projectRoots: [],
    dependencies: [],
    stages: [
      {
        stage: "review",
        instructions:
          "Identify the task-authorized vault and company or project scope. Start with its section index and read only relevant sub-indexes and linked notes. Check missing overview pages, broken internal links, TODO placeholders, thin notes and dated claims. Do not load secrets, credentials, unrelated client records or the entire vault into context. Return a prioritized list of concrete gaps with note paths, supporting evidence and suggested destinations. A date alone does not prove a claim is obsolete; label claims needing verification. Preserve existing notes and generated indexes. Do not research, write, delete, rebuild indexes, commit, synchronize or change vault settings during this audit.",
      },
    ],
  },
  {
    id: "campaign-analytics",
    name: "Campaign Analytics",
    description:
      "Plan social campaign performance analysis for Instagram, Meta ads, Google Analytics and Search Console; separate reach, clicks, leads and revenue.",
    source: "local-source:analytics/SKILL.md",
    sourceRevision: "local-reviewed-2026-10-03",
    sourceSha256: "4892e23a600a222aeb0fb2771338a64b6bdfb2ab03675286ac0c7b9b3ebd2583",
    reviewNote:
      "Reviewed the complete installed analytics tool map. Adapted to connector-independent planning and report review. Tool names are not treated as proof of availability or authorization; no account writes or publishing.",
    permissions: ["Read task-authorized source material"],
    projectRoots: [],
    dependencies: [],
    stages: [
      {
        stage: "plan",
        instructions:
          "Resolve the company, exact social or analytics account, campaign, date range, timezone and business question. Map search visibility to Search Console, site traffic and events to Google Analytics, paid Meta performance to ad-account insights and organic Instagram results to account/media insights. Check which existing authenticated read tools or exports are actually available; never invent a connector or borrow another company account. Define the comparison period and denominators before querying. Use only task-authorized read access. Do not create ads, schedule posts, send messages or change tracking.",
      },
      {
        stage: "review",
        instructions:
          "Check every reported metric against its source account, date range and definition. Separate organic from paid, impressions and reach from clicks, and inquiries from qualified leads, bookings and revenue. Use conversion denominators consistently. Missing attribution or an unavailable metric is unknown, not zero. Do not claim a campaign caused a sale merely because dates overlap. Cite source exports or receipts and distinguish observed results from recommendations. Draft the report for the current task; do not publish, email or alter a campaign.",
      },
    ],
  },
] satisfies readonly ManagedSkillManifest[];
