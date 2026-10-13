import type { SkillPackSourceSummary, SkillPackSummary } from "@t3tools/contracts";

/** One public repository a pack takes skills from, pinned to a commit. */
export interface SkillPackSource {
  /** Folder name under the skill library; also the prefix of each skill's id. */
  readonly id: string;
  /** Only `https://github.com/<owner>/<repo>` is ever downloaded. */
  readonly repositoryUrl: string;
  /** Full 40-character commit. Never a branch or "latest". */
  readonly commit: string;
  /** Where the skill folders live in the repository. */
  readonly skillsPath: string;
  /** Skill folders to take; every folder with a SKILL.md when absent. */
  readonly include?: readonly string[];
  /** The license file at the repository root. */
  readonly licenseFile: string;
  /** Short name of the license, shown beside the source. */
  readonly licenseName: string;
}

export interface SkillPack {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sources: readonly SkillPackSource[];
}

const GSAP: SkillPackSource = {
  id: "gsap",
  repositoryUrl: "https://github.com/greensock/gsap-skills",
  commit: "aed9cfd3277740755f6bfc1155c7aa645403b760",
  skillsPath: "skills",
  include: [
    "gsap-core",
    "gsap-frameworks",
    "gsap-performance",
    "gsap-plugins",
    "gsap-react",
    "gsap-scrolltrigger",
    "gsap-timeline",
    "gsap-utils",
  ],
  licenseFile: "LICENSE",
  licenseName: "MIT",
};

/**
 * The packs this build can install. Adding a source here is the only way a repository
 * becomes downloadable: the client names a pack id and nothing else.
 */
export const SKILL_PACKS: readonly SkillPack[] = [
  {
    id: "video-and-motion",
    title: "Video and Motion",
    description:
      "Make videos, motion graphics and timeline animations with agents: GSAP, HyperFrames and a short-form editing kit.",
    sources: [
      GSAP,
      {
        id: "hyperframes",
        repositoryUrl: "https://github.com/heygen-com/hyperframes",
        commit: "b9e511a7687a5b035a140325f2db3ddcb455cb5f",
        skillsPath: "skills",
        include: [
          "embedded-captions",
          "faceless-explainer",
          "figma",
          "general-video",
          "hyperframes",
          "hyperframes-animation",
          "hyperframes-audio",
          "hyperframes-cli",
          "hyperframes-core",
          "hyperframes-creative",
          "hyperframes-keyframes",
          "hyperframes-registry",
          "hyperframes-studio",
          "media-use",
          "motion-graphics",
          "music-to-video",
          "pr-to-video",
          "product-launch-video",
          "remotion-to-hyperframes",
          "slideshow",
          "talking-head-recut",
        ],
        licenseFile: "LICENSE",
        licenseName: "Apache-2.0",
      },
      {
        id: "hfkit",
        repositoryUrl: "https://github.com/nateherkai/hyperframes-student-kit",
        commit: "0d30152a82b9ceb93cfdd9bdbf46f0d5ab3cde86",
        skillsPath: ".claude/skills",
        include: [
          "cut-mistakes",
          "cut-silences",
          "edit-video",
          "hyperframes-video-beats",
          "make-a-video",
          "motion-showreel",
          "short-form-edit",
          "short-form-video",
          "video-storytelling",
          "website-to-hyperframes",
        ],
        licenseFile: "LICENSE",
        licenseName: "MIT",
      },
    ],
  },
  {
    id: "3d-and-webgl",
    title: "3D and WebGL",
    description:
      "Build 3D scenes and scroll animation for the web with three.js, React Three Fiber, Babylon.js and GSAP.",
    sources: [
      GSAP,
      {
        id: "webgl3d",
        repositoryUrl: "https://github.com/freshtechbro/claudedesignskills",
        commit: "1da73febff0c3e1dfefc07f8a5ef8f7d1dfdb6cd",
        skillsPath: ".claude/skills",
        include: [
          "threejs-webgl",
          "react-three-fiber",
          "babylonjs-engine",
          "playcanvas-engine",
          "aframe-webxr",
          "lightweight-3d-effects",
          "spline-interactive",
          "blender-web-pipeline",
          "web3d-integration-patterns",
        ],
        licenseFile: "LICENSE",
        licenseName: "MIT",
      },
    ],
  },
];

export const findPack = (id: string): SkillPack | undefined =>
  SKILL_PACKS.find((pack) => pack.id === id);

/** `owner/repo` of an allow-listed GitHub URL, or null for anything else. */
export function repositorySlug(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A single folder or file name: no separators, no `..`, nothing that can climb out of its parent. */
export const isSafeName = (name: string) => SAFE_NAME.test(name) && !name.includes("..");

const SAFE_PART = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A repository-relative path made only of safe names; a leading dot is allowed (`.claude/skills`). */
export const isSafeRelativePath = (path: string) =>
  path.length > 0 &&
  path.length <= 200 &&
  path.split("/").every((part) => SAFE_PART.test(part) && !part.includes(".."));

/** True when `target` is `base` or below it, judged on resolved, separator-normalised paths. */
export function isInside(base: string, target: string): boolean {
  const normalise = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = normalise(base);
  const t = normalise(target);
  return t === b || t.startsWith(`${b}/`);
}

/** Why a pack definition cannot be installed, or null. Run in tests over every shipped pack. */
export function packProblem(pack: SkillPack): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(pack.id)) return `${pack.id}: bad pack id`;
  for (const source of pack.sources) {
    const label = `${pack.id}/${source.id}`;
    if (!/^[a-z0-9]+$/.test(source.id)) return `${label}: bad source id`;
    if (repositorySlug(source.repositoryUrl) === null)
      return `${label}: repository is not on github.com`;
    if (!/^[a-f0-9]{40}$/.test(source.commit)) return `${label}: commit is not a full sha`;
    if (!isSafeRelativePath(source.skillsPath)) return `${label}: unsafe skills path`;
    if (!isSafeName(source.licenseFile)) return `${label}: unsafe license file`;
    if (source.include?.some((name) => !isSafeName(name))) return `${label}: unsafe skill name`;
  }
  return null;
}

/** What the library holds for one pack, as recorded in `installed-packs.json`. */
export interface InstalledSource {
  readonly commit: string;
  readonly skills: readonly string[];
}
export type InstalledPack = Readonly<Record<string, InstalledSource>>;

/** The pack as the client sees it, given what is installed. */
export function summarizePack(
  pack: SkillPack,
  installed: InstalledPack | undefined,
): SkillPackSummary {
  const sources: SkillPackSourceSummary[] = pack.sources.map((source) => ({
    id: source.id,
    repositoryUrl: source.repositoryUrl,
    commit: source.commit,
    license: source.licenseName,
    installedCommit: installed?.[source.id]?.commit ?? null,
  }));
  const isInstalled =
    sources.length > 0 && sources.every((source) => source.installedCommit !== null);
  const listed = pack.sources.reduce<number | null>(
    (total, source) => (total === null || !source.include ? null : total + source.include.length),
    0,
  );
  return {
    id: pack.id,
    title: pack.title,
    description: pack.description,
    sources,
    installed: isInstalled,
    skillCount: isInstalled
      ? pack.sources.reduce(
          (total, source) => total + (installed?.[source.id]?.skills.length ?? 0),
          0,
        )
      : listed,
    updateAvailable:
      isInstalled && sources.some((source) => source.installedCommit !== source.commit),
  };
}
