import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Path from "effect/Path";
import {
  ManagedSkillManifest,
  ManagedSkillSummary,
  ManagedSkillError,
  type ManagedSkillCandidate,
  type ManagedSkillEnableInput,
  type ManagedSkillLibrarySync,
  type ManagedSkillLoadInput,
  type ManagedSkillLoad,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { explicitSkillNames } from "./explicitSkillNames.ts";
import { isLibrarySource, libraryManifest } from "./skillLibrary.ts";
import { starterCatalog } from "./starterCatalog.ts";

export class ManagedSkillCatalog extends Context.Service<
  ManagedSkillCatalog,
  {
    readonly admitStarters: Effect.Effect<readonly ManagedSkillSummary[], ManagedSkillError>;
    readonly admit: (
      input: ManagedSkillManifest,
    ) => Effect.Effect<ManagedSkillSummary, ManagedSkillError>;
    readonly setEnabled: (input: ManagedSkillEnableInput) => Effect.Effect<void, ManagedSkillError>;
    readonly list: Effect.Effect<readonly ManagedSkillSummary[], ManagedSkillError>;
    readonly candidates: (input: {
      task: string;
      cwd: string | null;
    }) => Effect.Effect<readonly ManagedSkillCandidate[], ManagedSkillError>;
    readonly load: (
      input: ManagedSkillLoadInput,
    ) => Effect.Effect<ManagedSkillLoad, ManagedSkillError>;
    /** Every enabled skill usable in `cwd`, for a judge that reads the whole catalog. */
    readonly usable: (input: {
      cwd: string | null;
    }) => Effect.Effect<readonly ManagedSkillCandidate[], ManagedSkillError>;
    /**
     * Indexes three libraries as disabled revisions pinned to each file's hash:
     * the user's own skills at `<root>/<folder>/SKILL.md`, the skills of installed
     * Claude plugins at `<plugins>/cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md`
     * (the newest version of each), and skills downloaded from elsewhere at
     * `<downloaded>/<source>/<folder>/SKILL.md`, a folder no CLI loads by itself.
     * `enable` turns on the user's own and installed plugin skills as they are now.
     * Downloaded skills stay off until the caller names their source in
     * `enableDownloaded`, the one-click switch for that group. A skill the user
     * switched off by hand is never switched back on by a sync. All paths have
     * defaults and are passed by tests.
     */
    readonly syncLibrary: (input: {
      enable: boolean;
      enableDownloaded?: readonly string[];
      root?: string;
      downloaded?: string;
      plugins?: string;
    }) => Effect.Effect<ManagedSkillLibrarySync, ManagedSkillError>;
    /**
     * One signal after the user's skills folder or the installed plugins' folder has changed
     * and gone quiet, so the caller can sync once per burst of edits. A folder that does not
     * exist yet is not watched; the caller's periodic pass still covers it.
     */
    readonly libraryChanges: (input?: {
      root?: string;
      plugins?: string;
      quiet?: Duration.Input;
    }) => Stream.Stream<void>;
  }
>()("t3/skills/ManagedSkillCatalog") {}

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ManagedSkillManifest));
const decodeManifest = Schema.decodeUnknownEffect(ManagedSkillManifest);
const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(ManagedSkillSummary));
const decodeStages = Schema.decodeEffect(Schema.fromJsonString(ManagedSkillManifest.fields.stages));
const isSkillError = Schema.is(ManagedSkillError);
const storage = () => new ManagedSkillError({ reason: "storage" });
const stopWords = new Set([
  "the",
  "and",
  "with",
  "for",
  "this",
  "that",
  "from",
  "into",
  "then",
  "some",
  "please",
]);
const words = (value: string) => [
  ...new Set(
    (value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
      .filter((word) => !stopWords.has(word))
      .map((word) => (word.endsWith("s") ? word.slice(0, -1) : word)),
  ),
];
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const allowed = (skill: ManagedSkillSummary, cwd: string | null) =>
    skill.projectRoots.length === 0 ||
    (cwd !== null && skill.projectRoots.includes(pathService.resolve(cwd)));
  const admit = Effect.fn("ManagedSkillCatalog.admit")(function* (input: ManagedSkillManifest) {
    const manifest = yield* decodeManifest(input).pipe(
      Effect.mapError(() => new ManagedSkillError({ reason: "invalid_manifest" })),
    );
    if (
      new Set(manifest.stages.map((s) => s.stage)).size !== manifest.stages.length ||
      manifest.projectRoots.some(
        (root) => !pathService.isAbsolute(root) || root !== pathService.resolve(root),
      ) ||
      manifest.dependencies.some(
        (d) => !(pathService.isAbsolute(d.path) || d.path.startsWith("~/")),
      )
    )
      return yield* new ManagedSkillError({ reason: "invalid_manifest" });
    const canonical = yield* encodeManifest(manifest).pipe(Effect.mapError(storage));
    const revision = digest(canonical);
    const { stages, ...metadata } = manifest;
    const summary: ManagedSkillSummary = {
      ...metadata,
      revision,
      enabled: false,
      stages: stages.map(({ stage, instructions }) => ({
        stage,
        utf8Bytes: Buffer.byteLength(instructions, "utf8"),
      })),
    };
    const metadataJson = yield* encode(summary).pipe(Effect.mapError(storage));
    const stagesJson = yield* encode(stages).pipe(Effect.mapError(storage));
    // Immutable revisions enter disabled. Never put imported content in an autoload directory.
    yield* sql`INSERT INTO workbench_managed_skills (id,revision,metadata_json,stages_json)
      SELECT ${manifest.id},${revision},${metadataJson},${stagesJson}
      WHERE (SELECT count(*) FROM workbench_managed_skills) < 1024
      ON CONFLICT(id,revision) DO NOTHING`.pipe(Effect.mapError(storage));
    const [row] = yield* sql<{
      enabled: number;
    }>`SELECT enabled FROM workbench_managed_skills WHERE id=${manifest.id} AND revision=${revision}`.pipe(
      Effect.mapError(storage),
    );
    if (!row) return yield* new ManagedSkillError({ reason: "catalog_full" });
    return { ...summary, enabled: row.enabled === 1 };
  });
  // `remember` records the user's choice, so an automatic sync leaves a skill they
  // turned off alone; the sync itself enables without touching that record.
  const switchRevision = (input: ManagedSkillEnableInput, remember: boolean) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [row] =
            yield* sql`SELECT id FROM workbench_managed_skills WHERE id=${input.id} AND revision=${input.revision}`;
          if (!row) return yield* new ManagedSkillError({ reason: "not_found" });
          if (input.enabled)
            yield* sql`UPDATE workbench_managed_skills SET enabled=0 WHERE id=${input.id}`;
          yield* sql`UPDATE workbench_managed_skills SET enabled=${input.enabled ? 1 : 0} WHERE id=${input.id} AND revision=${input.revision}`;
          if (!remember) return;
          if (input.enabled)
            yield* sql`DELETE FROM workbench_managed_skill_opt_outs WHERE id=${input.id}`;
          else {
            const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
            yield* sql`INSERT INTO workbench_managed_skill_opt_outs (id,created_at) VALUES (${input.id},${at}) ON CONFLICT(id) DO NOTHING`;
          }
        }),
      )
      .pipe(Effect.mapError((e) => (isSkillError(e) ? e : storage())));
  const setEnabled = Effect.fn("ManagedSkillCatalog.setEnabled")(function* (
    input: ManagedSkillEnableInput,
  ) {
    yield* switchRevision(input, true);
  });
  const list = Effect.gen(function* () {
    // Only metadata is read for discovery; instructions stay in a separate column.
    const rows = yield* sql<{
      metadata_json: string;
      enabled: number;
    }>`SELECT metadata_json, enabled FROM workbench_managed_skills ORDER BY id,revision LIMIT 1024`.pipe(
      Effect.mapError(storage),
    );
    return yield* Effect.forEach(rows, (row) =>
      decodeSummary(row.metadata_json).pipe(
        Effect.map((metadata) => ({ ...metadata, enabled: row.enabled === 1 })),
        Effect.mapError(storage),
      ),
    );
  });
  const expandHome = (path: string) =>
    path.startsWith("~/") ? pathService.join(NodeOS.homedir(), path.slice(2)) : path;
  const missing = Effect.fn("ManagedSkillCatalog.missing")(function* (skill: ManagedSkillSummary) {
    return yield* Effect.filter(skill.dependencies, (dependency) => {
      const path = expandHome(dependency.path);
      return fs.stat(path).pipe(
        Effect.map(
          (info) =>
            info.type !== "File" ||
            (dependency.executable && platform !== "win32" && (info.mode & 0o111) === 0),
        ),
        Effect.orElseSucceed(() => true),
      );
    }).pipe(Effect.map((items) => items.map((item) => item.path)));
  });
  const candidates = Effect.fn("ManagedSkillCatalog.candidates")(function* (input: {
    task: string;
    cwd: string | null;
  }) {
    const terms = words(input.task);
    const references = explicitSkillNames(input.task);
    const explicit = (skill: ManagedSkillSummary) =>
      references.has(skill.id) || references.has(`managed:${skill.id}`);
    const ranked = (yield* list)
      .filter((skill) => skill.enabled && allowed(skill, input.cwd))
      .map((skill) => {
        const tokens = new Set(words(`${skill.id} ${skill.name} ${skill.description}`));
        const matchedTerms = terms.filter((word) => tokens.has(word));
        return { ...skill, matchedTerms };
      })
      .filter(
        (skill) =>
          explicit(skill) ||
          skill.matchedTerms.length >= 2 ||
          (terms.length === 1 && skill.matchedTerms.length === 1),
      )
      .sort(
        (a, b) =>
          Number(explicit(b)) - Number(explicit(a)) ||
          b.matchedTerms.length - a.matchedTerms.length ||
          a.id.localeCompare(b.id),
      );
    const checked: ManagedSkillCandidate[] = [];
    let available = 0;
    // Check beyond unavailable top hits, without stat-ing the entire catalog on every keystroke.
    for (const skill of ranked) {
      if (available >= 3 && !explicit(skill)) break;
      const missingDependencies = yield* missing(skill);
      checked.push({ ...skill, missingDependencies });
      if (missingDependencies.length === 0) available++;
    }
    return checked
      .sort(
        (a, b) =>
          Number(explicit(b)) - Number(explicit(a)) ||
          Number(a.missingDependencies.length > 0) - Number(b.missingDependencies.length > 0) ||
          b.matchedTerms.length - a.matchedTerms.length ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 3);
  });
  const usable = Effect.fn("ManagedSkillCatalog.usable")(function* (input: { cwd: string | null }) {
    const enabled = (yield* list).filter((skill) => skill.enabled && allowed(skill, input.cwd));
    const checked = yield* Effect.forEach(
      enabled,
      (skill) =>
        missing(skill).pipe(
          Effect.map((missingDependencies) => ({
            ...skill,
            matchedTerms: [],
            missingDependencies,
          })),
        ),
      { concurrency: 16 },
    );
    return checked.filter((skill) => skill.missingDependencies.length === 0);
  });
  const load = Effect.fn("ManagedSkillCatalog.load")(function* (input: ManagedSkillLoadInput) {
    const [row] = yield* sql<{
      metadata_json: string;
      stages_json: string;
      enabled: number;
    }>`SELECT metadata_json,stages_json,enabled FROM workbench_managed_skills WHERE id=${input.id} AND revision=${input.revision}`.pipe(
      Effect.mapError(storage),
    );
    if (!row) return yield* new ManagedSkillError({ reason: "not_found" });
    if (!row.enabled) return yield* new ManagedSkillError({ reason: "disabled" });
    const skill = yield* decodeSummary(row.metadata_json).pipe(Effect.mapError(storage));
    if (!allowed(skill, input.cwd))
      return yield* new ManagedSkillError({ reason: "wrong_project" });
    if ((yield* missing(skill)).length)
      return yield* new ManagedSkillError({ reason: "dependency_missing" });
    // A library entry points at a file. If the file changed since it was indexed, the
    // enabled revision no longer describes it; a new sync has to admit the new content.
    if (isLibrarySource(skill.source)) {
      const current = yield* fs.readFileString(expandHome(skill.dependencies[0]?.path ?? "")).pipe(
        Effect.map(digest),
        Effect.orElseSucceed(() => ""),
      );
      if (current !== skill.sourceSha256)
        return yield* new ManagedSkillError({ reason: "source_changed" });
    }
    const stages = yield* decodeStages(row.stages_json).pipe(Effect.mapError(storage));
    const { revision: _revision, enabled: _enabled, stages: _stages, ...metadata } = skill;
    const canonical = yield* encodeManifest({ ...metadata, stages }).pipe(Effect.mapError(storage));
    if (digest(canonical) !== input.revision) return yield* storage();
    const stage = stages.find((s) => s.stage === input.stage);
    if (!stage) return yield* new ManagedSkillError({ reason: "stage_missing" });
    return {
      id: input.id,
      revision: input.revision,
      stage: stage.stage,
      instructions: stage.instructions,
      utf8Bytes: Buffer.byteLength(stage.instructions, "utf8"),
      tokenCount: null,
      permissions: skill.permissions,
    };
  });
  const admitStarters = sql
    .withTransaction(Effect.forEach(starterCatalog, admit))
    .pipe(Effect.mapError((error) => (isSkillError(error) ? error : storage())));
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  /**
   * Skills of installed plugins: `<cache>/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md`.
   * An update leaves the old version beside the new one, so each plugin+skill keeps only
   * the newest version folder. Marketplace checkouts are catalogs of plugins that are not
   * installed, so they are never read.
   */
  const pluginSkills = Effect.fn("ManagedSkillCatalog.pluginSkills")(function* (cache: string) {
    const names = (directory: string) =>
      fs.readDirectory(directory).pipe(
        Effect.map((entries) => entries.toSorted()),
        Effect.orElseSucceed(() => [] as string[]),
      );
    const newest = new Map<
      string,
      { plugin: string; skill: string; file: string; version: string; modified: number }
    >();
    for (const marketplace of yield* names(cache)) {
      for (const plugin of yield* names(pathService.join(cache, marketplace))) {
        const pluginDirectory = pathService.join(cache, marketplace, plugin);
        for (const version of yield* names(pluginDirectory)) {
          const versionDirectory = pathService.join(pluginDirectory, version);
          const modified = yield* fs.stat(versionDirectory).pipe(
            Effect.map((info) => (info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0)),
            Effect.orElseSucceed(() => 0),
          );
          for (const skill of yield* names(pathService.join(versionDirectory, "skills"))) {
            const key = `${plugin}/${skill}`;
            const held = newest.get(key);
            if (
              held &&
              (held.modified > modified ||
                (held.modified === modified &&
                  held.version.localeCompare(version, "en", { numeric: true }) >= 0))
            )
              continue;
            newest.set(key, {
              plugin,
              skill,
              version,
              modified,
              file: pathService.join(versionDirectory, "skills", skill, "SKILL.md"),
            });
          }
        }
      }
    }
    return [...newest.values()]
      .toSorted((a, b) => `${a.plugin}/${a.skill}`.localeCompare(`${b.plugin}/${b.skill}`))
      .map(({ plugin, skill, file }) => ({ id: skill, file, plugin, source: undefined }));
  });
  const syncLibrary = Effect.fn("ManagedSkillCatalog.syncLibrary")(function* (input: {
    enable: boolean;
    enableDownloaded?: readonly string[];
    root?: string;
    downloaded?: string;
    plugins?: string;
  }) {
    const home = NodeOS.homedir();
    const root = input.root ?? pathService.join(home, ".claude", "skills");
    const downloaded =
      input.downloaded ??
      (serverConfig._tag === "Some"
        ? pathService.join(serverConfig.value.baseDir, "skill-library")
        : null);
    const read = (directory: string) =>
      fs.readDirectory(directory).pipe(Effect.map((names) => names.toSorted()));
    // A machine with no skills folder of its own can still hold downloaded skills.
    const own = (yield* read(root).pipe(
      downloaded
        ? Effect.orElseSucceed(() => [] as string[])
        : Effect.mapError(() => new ManagedSkillError({ reason: "library_missing" })),
    )).map((folder) => ({
      id: folder,
      file: pathService.join(root, folder, "SKILL.md"),
      plugin: undefined,
      source: undefined,
    }));
    // A downloaded skill takes its source as a prefix, so it can never replace one of the user's.
    // Dot-prefixed folders are an install in progress, never a source.
    const sources = (
      downloaded ? yield* read(downloaded).pipe(Effect.orElseSucceed(() => [] as string[])) : []
    ).filter((source) => !source.startsWith("."));
    const fetched = (yield* Effect.forEach(sources, (source) =>
      read(pathService.join(downloaded!, source)).pipe(
        Effect.orElseSucceed(() => []),
        Effect.map((folders) =>
          folders.map((folder) => ({
            id: `${source}-${folder}`,
            file: pathService.join(downloaded!, source, folder, "SKILL.md"),
            plugin: undefined,
            source,
          })),
        ),
      ),
    )).flat();
    const pluginsDirectory = input.plugins ?? pathService.join(home, ".claude", "plugins");
    const installed = yield* pluginSkills(pathService.join(pluginsDirectory, "cache"));
    const optedOut = new Set(
      (yield* sql<{
        id: string;
      }>`SELECT id FROM workbench_managed_skill_opt_outs`.pipe(Effect.mapError(storage))).map(
        (row) => row.id,
      ),
    );
    const known = new Set((yield* list).map((skill) => `${skill.id}:${skill.revision}`));
    let found = 0;
    let added = 0;
    let skipped = 0;
    let enabled = 0;
    for (const { id: folder, file, plugin, source } of [...own, ...installed, ...fetched]) {
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
      if (text === null) continue;
      found++;
      const manifest = libraryManifest({
        folder,
        // Home-relative, so the same catalog reads correctly if the home folder moves.
        path: file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file,
        text,
        sha256: digest(text),
        ...(plugin ? { plugin } : {}),
      });
      // One unreadable or oversized skill must not stop the rest of the library.
      const summary = manifest
        ? yield* admit(manifest).pipe(Effect.orElseSucceed(() => null))
        : null;
      if (!summary) {
        skipped++;
        continue;
      }
      if (!known.has(`${summary.id}:${summary.revision}`)) added++;
      // A skill the user switched off stays off. A sync turns on the user's own and plugin
      // skills; a downloaded one waits for its source to be named.
      if (summary.enabled) enabled++;
      else if (
        input.enable &&
        !optedOut.has(summary.id) &&
        (source === undefined || input.enableDownloaded?.includes(source))
      ) {
        yield* switchRevision({ id: summary.id, revision: summary.revision, enabled: true }, false);
        enabled++;
      }
    }
    return { found, added, skipped, enabled };
  });
  const libraryChanges = (
    input: { root?: string; plugins?: string; quiet?: Duration.Input } = {},
  ) => {
    const home = NodeOS.homedir();
    const roots = [
      input.root ?? pathService.join(home, ".claude", "skills"),
      pathService.join(input.plugins ?? pathService.join(home, ".claude", "plugins"), "cache"),
    ];
    return Stream.mergeAll(
      roots.map((root) =>
        fs.watch(root, { recursive: true }).pipe(
          // A dependency folder inside a skill or plugin changes constantly and holds no skills.
          Stream.filter((event) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(event.path)),
          Stream.catchCause(() => Stream.empty),
        ),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce(input.quiet ?? Duration.seconds(3)),
      Stream.map(() => undefined),
    );
  };
  return ManagedSkillCatalog.of({
    libraryChanges,
    admit,
    admitStarters,
    setEnabled,
    list,
    candidates,
    load,
    usable,
    syncLibrary,
  });
});
export const layer = Layer.effect(ManagedSkillCatalog, make);
