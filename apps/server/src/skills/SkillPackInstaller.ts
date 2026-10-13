import { SkillPackError, type SkillPackSummary } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import { ManagedSkillCatalog } from "./ManagedSkillCatalog.ts";
import { SkillPackDownloader } from "./SkillPackDownloader.ts";
import {
  SKILL_PACKS,
  isInside,
  isSafeName,
  packProblem,
  summarizePack,
  type InstalledPack,
  type SkillPack,
  type SkillPackSource,
} from "./skillPacks.ts";

export class SkillPackInstaller extends Context.Service<
  SkillPackInstaller,
  {
    readonly list: Effect.Effect<readonly SkillPackSummary[], SkillPackError>;
    /** Downloads every source of the pack at its pinned commit, indexes the skills and turns them on. */
    readonly install: (packId: string) => Effect.Effect<SkillPackSummary, SkillPackError>;
    /** Deletes the source folders this pack installed, except ones another installed pack still uses. */
    readonly remove: (packId: string) => Effect.Effect<SkillPackSummary, SkillPackError>;
  }
>()("t3/skills/SkillPackInstaller") {}

/** Limits per source, counted on the files that would be copied. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_FILES = 2_000;
const MAX_DEPTH = 8;
const RECORD_FILE = "installed-packs.json";
const SOURCES_FILE = "SOURCES.md";
const SOURCES_HEADER =
  "# Downloaded Skills\n\nFetched by Skill Packs from the repositories below, at the commits shown. Each folder keeps its upstream files and license terms.\n\n";

const InstalledRecord = Schema.Struct({
  packs: Schema.Record(
    Schema.String,
    Schema.Record(
      Schema.String,
      Schema.Struct({ commit: Schema.String, skills: Schema.Array(Schema.String) }),
    ),
  ),
});
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstalledRecord));

/** A directory entry name that cannot climb out of its parent. */
const isPlainEntryName = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);

const storage = () => new SkillPackError({ reason: "storage" });

export interface SkillPackInstallerOptions {
  /** The library folder: `<library>/<source>/<skill>/SKILL.md`. */
  readonly library: string;
  /** Where the catalog looks for the user's own skills and plugins; the defaults in production. */
  readonly root?: string;
  readonly plugins?: string;
  /** The packs to offer; the shipped ones unless a test passes its own. */
  readonly packs?: readonly SkillPack[];
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

export const makeInstaller = (options: SkillPackInstallerOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const downloader = yield* SkillPackDownloader;
    const catalog = yield* ManagedSkillCatalog;
    const lock = yield* Semaphore.make(1);
    const { library } = options;
    const packList = options.packs ?? SKILL_PACKS;
    const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
    const maxFiles = options.maxFiles ?? MAX_SOURCE_FILES;
    const recordPath = path.join(library, RECORD_FILE);
    const sourcesPath = path.join(library, SOURCES_FILE);

    const readInstalled = Effect.gen(function* () {
      const text = yield* fs.readFileString(recordPath);
      return (yield* decodeRecord(text)).packs;
    }).pipe(Effect.orElseSucceed((): Readonly<Record<string, InstalledPack>> => ({})));
    const writeInstalled = (packs: Readonly<Record<string, InstalledPack>>) =>
      Effect.gen(function* () {
        const text = yield* encodeRecord({ packs });
        yield* fs.makeDirectory(library, { recursive: true });
        // Written beside the record and renamed, so a crash never leaves half a file.
        const temporary = `${recordPath}.${yield* Clock.currentTimeMillis}.tmp`;
        yield* fs.writeFileString(temporary, `${text}\n`);
        yield* fs.rename(temporary, recordPath);
      }).pipe(Effect.mapError(storage));

    const summaries = (packs: Readonly<Record<string, InstalledPack>>) =>
      packList.map((pack) => summarizePack(pack, packs[pack.id]));

    // The walk never follows a link: a path that reads as a link is skipped, so `stat` below
    // only ever sees real files and folders.
    const entryKind = (target: string) =>
      fs.readLink(target).pipe(
        Effect.map(() => ({ kind: "link" }) as const),
        Effect.catch(() =>
          fs.stat(target).pipe(
            Effect.map((info) =>
              info.type === "Directory"
                ? ({ kind: "directory" } as const)
                : info.type === "File"
                  ? ({ kind: "file", size: Number(info.size) } as const)
                  : ({ kind: "other" } as const),
            ),
            Effect.orElseSucceed(() => ({ kind: "missing" }) as const),
          ),
        ),
      );

    /** Every regular file under `directory`, relative to it, counted against the limits. */
    const collectFiles = (
      root: string,
      directory: string,
      totals: { bytes: number; files: number },
    ) => {
      const walk = (current: string, depth: number): Effect.Effect<string[], SkillPackError> =>
        Effect.gen(function* () {
          if (depth > MAX_DEPTH) return [];
          const found: string[] = [];
          const names = yield* fs.readDirectory(current).pipe(Effect.mapError(storage));
          for (const name of names.toSorted()) {
            if (name === ".git" || !isPlainEntryName(name)) continue;
            const full = path.join(current, name);
            // Belt and braces: nothing outside the extracted tree is ever read.
            if (!isInside(root, full)) continue;
            const entry = yield* entryKind(full);
            if (entry.kind === "directory") found.push(...(yield* walk(full, depth + 1)));
            else if (entry.kind === "file") {
              totals.bytes += entry.size;
              totals.files += 1;
              if (totals.bytes > maxBytes || totals.files > maxFiles)
                return yield* new SkillPackError({ reason: "too_large" });
              found.push(path.relative(directory, full));
            }
          }
          return found;
        });
      return walk(directory, 0);
    };

    /** Copies the source's skills from the downloaded tree into `staging`; returns the folder names. */
    const stageSkills = (source: SkillPackSource, downloaded: string, staging: string) =>
      Effect.gen(function* () {
        const skillsRoot = path.join(downloaded, source.skillsPath);
        if (
          !isInside(downloaded, skillsRoot) ||
          (yield* entryKind(skillsRoot)).kind !== "directory"
        )
          return yield* new SkillPackError({ reason: "no_skills" });
        const folders =
          source.include ??
          (yield* fs.readDirectory(skillsRoot).pipe(Effect.mapError(storage))).toSorted();
        const totals = { bytes: 0, files: 0 };
        const copied: string[] = [];
        for (const folder of folders) {
          if (!isSafeName(folder)) continue;
          const from = path.join(skillsRoot, folder);
          if ((yield* entryKind(from)).kind !== "directory") continue;
          if ((yield* entryKind(path.join(from, "SKILL.md"))).kind !== "file") continue;
          for (const file of yield* collectFiles(downloaded, from, totals)) {
            const to = path.join(staging, folder, file);
            if (!isInside(staging, to)) return yield* new SkillPackError({ reason: "storage" });
            yield* fs
              .makeDirectory(path.dirname(to), { recursive: true })
              .pipe(Effect.mapError(storage));
            yield* fs.copyFile(path.join(from, file), to).pipe(Effect.mapError(storage));
          }
          copied.push(folder);
        }
        if (copied.length === 0) return yield* new SkillPackError({ reason: "no_skills" });
        const license = path.join(downloaded, source.licenseFile);
        if ((yield* entryKind(license)).kind === "file")
          yield* fs
            .copyFile(license, path.join(staging, `LICENSE-${source.id}`))
            .pipe(Effect.mapError(storage));
        return copied;
      });

    /** Replaces `<library>/<source>` with `staging`; the old copy comes back if the swap fails. */
    const swapIn = (staging: string, destination: string) =>
      Effect.gen(function* () {
        const previous = `${destination}.old-${yield* Clock.currentTimeMillis}`;
        const hadPrevious = yield* fs.exists(destination);
        if (hadPrevious) yield* fs.rename(destination, previous);
        yield* fs
          .rename(staging, destination)
          .pipe(
            Effect.tapError(() => (hadPrevious ? fs.rename(previous, destination) : Effect.void)),
          );
        if (hadPrevious) yield* fs.remove(previous, { recursive: true, force: true });
      }).pipe(Effect.mapError(storage));

    // The staging folders sit beside the destination under a dot prefix, which the catalog skips.
    const installSource = (source: SkillPackSource) =>
      Effect.scoped(
        Effect.gen(function* () {
          const downloaded = yield* fs
            .makeTempDirectoryScoped({ prefix: "skill-pack-" })
            .pipe(Effect.mapError(storage));
          yield* downloader.fetch(source, downloaded);
          yield* fs.makeDirectory(library, { recursive: true }).pipe(Effect.mapError(storage));
          const staging = yield* fs
            .makeTempDirectory({ directory: library, prefix: `.staging-${source.id}-` })
            .pipe(Effect.mapError(storage));
          return yield* Effect.gen(function* () {
            const skills = yield* stageSkills(source, downloaded, staging);
            yield* swapIn(staging, path.join(library, source.id));
            return skills;
          }).pipe(
            Effect.onError(() =>
              fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          );
        }),
      );

    const sourceLine = (source: SkillPackSource, count: number) =>
      `- \`${source.id}/\` — ${source.repositoryUrl} @ ${source.commit.slice(0, 12)} — ${count} skills — license: ${source.licenseFile}`;
    const lineFor = (id: string) => `- \`${id}/\` — `;
    /** Adds, replaces or (with a null `line`) drops one source's entry in SOURCES.md. */
    const updateSourcesFile = (id: string, line: string | null) =>
      Effect.gen(function* () {
        const existing = yield* fs
          .readFileString(sourcesPath)
          .pipe(Effect.orElseSucceed(() => SOURCES_HEADER));
        const kept = existing.split("\n").filter((entry) => !entry.startsWith(lineFor(id)));
        const body = kept.join("\n").replace(/\n+$/, "");
        const next = line === null ? body : `${body}\n${line}`;
        yield* fs.writeFileString(sourcesPath, `${next}\n`);
      }).pipe(Effect.mapError(storage));

    const install = (packId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const pack = packList.find((entry) => entry.id === packId);
          if (!pack || packProblem(pack) !== null)
            return yield* new SkillPackError({ reason: "unknown_pack" });
          let packs = yield* readInstalled;
          for (const source of pack.sources) {
            const skills = yield* installSource(source);
            // Recorded source by source, so a later failure still leaves every folder removable.
            packs = {
              ...packs,
              [pack.id]: { ...packs[pack.id], [source.id]: { commit: source.commit, skills } },
            };
            yield* writeInstalled(packs);
            yield* updateSourcesFile(source.id, sourceLine(source, skills.length));
          }
          // Index the new files and turn this pack's on, which is what pressing Install asks
          // for; a skill the user switched off stays off.
          yield* catalog
            .syncLibrary({
              enable: true,
              enableDownloaded: pack.sources.map((source) => source.id),
              downloaded: library,
              ...(options.root ? { root: options.root } : {}),
              ...(options.plugins ? { plugins: options.plugins } : {}),
            })
            .pipe(Effect.mapError(() => new SkillPackError({ reason: "index_failed" })));
          return summarizePack(pack, packs[pack.id]);
        }),
      );

    const remove = (packId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const pack = packList.find((entry) => entry.id === packId);
          if (!pack) return yield* new SkillPackError({ reason: "unknown_pack" });
          const all = yield* readInstalled;
          const mine = all[pack.id] ?? {};
          const { [pack.id]: _removed, ...rest } = all;
          const stillUsed = new Set(
            Object.values(rest).flatMap((installed) => Object.keys(installed)),
          );
          for (const id of Object.keys(mine)) {
            // The record is a file on disk: only a plain source name inside the library is ever deleted.
            const folder = path.join(library, id);
            if (
              stillUsed.has(id) ||
              !/^[a-z0-9]+$/.test(id) ||
              !isInside(library, folder) ||
              folder === library
            )
              continue;
            yield* fs
              .remove(folder, { recursive: true, force: true })
              .pipe(Effect.mapError(storage));
            yield* updateSourcesFile(id, null);
          }
          yield* writeInstalled(rest);
          return summarizePack(pack, undefined);
        }),
      );

    const list = readInstalled.pipe(Effect.map(summaries));
    return SkillPackInstaller.of({ list, install, remove });
  });

export const layer = Layer.effect(
  SkillPackInstaller,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeInstaller({ library: path.join(config.baseDir, "skill-library") });
  }),
);
