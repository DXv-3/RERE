import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ManagedSkillManifest } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ManagedSkillCatalog from "./ManagedSkillCatalog.ts";
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fixture: ManagedSkillManifest = {
  id: "reel-review",
  name: "Reel Review",
  description: "Review video reel captions and visual quality",
  source: "local:reviewed-fixture",
  sourceRevision: "1",
  sourceSha256: "a".repeat(64),
  reviewNote: "Reviewed fixture without publishing or tool execution",
  permissions: ["read supplied media"],
  projectRoots: ["/project"],
  dependencies: [],
  stages: [
    { stage: "plan", instructions: "Ask for the asset and campaign goal." },
    { stage: "review", instructions: "Review only the supplied frames. Do not publish." },
  ],
};
const layer = ManagedSkillCatalog.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);
it.effect("admits disabled immutable revisions and discovers metadata without stage bodies", () =>
  Effect.gen(function* () {
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    const first = yield* catalog.admit(fixture);
    expect(first.enabled).toBe(false);
    expect(yield* catalog.candidates({ task: "Review video reel", cwd: "/project" })).toEqual([]);
    expect(
      (yield* Effect.flip(catalog.load({ ...first, stage: "review", cwd: "/project" }))).reason,
    ).toBe("disabled");
    yield* catalog.setEnabled({ ...first, enabled: true });
    const found = yield* catalog.candidates({ task: "Review video reel", cwd: "/project" });
    expect(found).toHaveLength(1);
    expect(yield* encodeUnknown(found)).not.toContain("Review only the supplied frames");
    const loaded = yield* catalog.load({ ...first, stage: "review", cwd: "/project" });
    expect(loaded.instructions).toBe(fixture.stages[1]!.instructions);
    expect(loaded.utf8Bytes).toBe(Buffer.byteLength(loaded.instructions));
    expect(loaded.tokenCount).toBeNull();
    expect((yield* catalog.admit(fixture)).enabled).toBe(true);
    expect(yield* catalog.list).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "admits the reviewed starter set disabled, preserves enablement on repeat and rolls back a partial failure",
  () =>
    Effect.gen(function* () {
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      expect(yield* catalog.list).toEqual([]);
      const first = yield* catalog.admitStarters;
      expect(first).toHaveLength(4);
      expect(first.every((skill) => !skill.enabled)).toBe(true);
      yield* catalog.setEnabled({ ...first[0]!, enabled: true });
      const repeated = yield* catalog.admitStarters;
      expect(repeated.find((skill) => skill.id === first[0]!.id)?.enabled).toBe(true);
      expect(yield* catalog.list).toHaveLength(4);
      // Exercise the atomic operation with a real SQLite write failure after the first insert.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM workbench_managed_skills`;
      yield* sql`CREATE TRIGGER reject_starter BEFORE INSERT ON workbench_managed_skills
      WHEN NEW.id='focused-code-change' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      expect((yield* Effect.flip(catalog.admitStarters)).reason).toBe("storage");
      expect(yield* catalog.list).toEqual([]);
    }).pipe(Effect.provide(layer)),
);
it.effect("pins a revision, supports rollback and rejects stale or disabled loads", () =>
  Effect.gen(function* () {
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    const old = yield* catalog.admit(fixture);
    yield* catalog.setEnabled({ ...old, enabled: true });
    const next = yield* catalog.admit({
      ...fixture,
      stages: [{ stage: "review", instructions: "Revised review" }],
    });
    expect(next.revision).not.toBe(old.revision);
    yield* catalog.setEnabled({ ...next, enabled: true });
    expect(
      (yield* Effect.flip(catalog.load({ ...old, stage: "review", cwd: "/project" }))).reason,
    ).toBe("disabled");
    yield* catalog.setEnabled({ ...old, enabled: true });
    expect((yield* catalog.load({ ...old, stage: "review", cwd: "/project" })).instructions).toBe(
      fixture.stages[1]!.instructions,
    );
    expect((yield* catalog.list).filter((s) => s.enabled)).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
it.effect("enforces scope, dependencies, stage bounds and content integrity", () =>
  Effect.gen(function* () {
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    const entry = yield* catalog.admit(fixture);
    yield* catalog.setEnabled({ ...entry, enabled: true });
    expect(yield* catalog.candidates({ task: "review video reel", cwd: "/another" })).toEqual([]);
    expect(
      (yield* Effect.flip(catalog.load({ ...entry, stage: "review", cwd: "/another" }))).reason,
    ).toBe("wrong_project");
    expect(
      (yield* Effect.flip(catalog.load({ ...entry, stage: "implement", cwd: "/project" }))).reason,
    ).toBe("stage_missing");
    const missing = yield* catalog.admit({
      ...fixture,
      dependencies: [{ path: "/workbench-nonexistent-dependency-fixture", executable: true }],
    });
    yield* catalog.setEnabled({ ...missing, enabled: true });
    expect(
      (yield* catalog.candidates({ task: "review video reel", cwd: "/project" }))[0]!
        .missingDependencies,
    ).toHaveLength(1);
    expect(
      (yield* Effect.flip(catalog.load({ ...missing, stage: "review", cwd: "/project" }))).reason,
    ).toBe("dependency_missing");
    for (const invalid of [
      { ...fixture, stages: [{ stage: "review" as const, instructions: "x".repeat(8_001) }] },
      { ...fixture, stages: [fixture.stages[0]!, fixture.stages[0]!] },
      { ...fixture, projectRoots: ["relative"] },
    ])
      expect((yield* Effect.flip(catalog.admit(invalid))).reason).toBe("invalid_manifest");
    yield* catalog.setEnabled({ ...entry, enabled: true });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE workbench_managed_skills SET stages_json=${'[ { "stage": "review", "instructions": "tampered" } ]'} WHERE revision=${entry.revision}`;
    expect(
      (yield* Effect.flip(catalog.load({ ...entry, stage: "review", cwd: "/project" }))).reason,
    ).toBe("storage");
  }).pipe(Effect.provide(layer)),
);
it.effect("caps discovery at three candidates and gives no match for unrelated tasks", () =>
  Effect.gen(function* () {
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    for (let index = 0; index < 5; index++) {
      const entry = yield* catalog.admit({ ...fixture, id: `reel-${index}` });
      yield* catalog.setEnabled({ ...entry, enabled: true });
    }
    expect(yield* catalog.candidates({ task: "review video reel", cwd: "/project" })).toHaveLength(
      3,
    );
    expect(yield* catalog.candidates({ task: "database migration", cwd: "/project" })).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
it.effect("honors explicit managed references without bypassing scope or enablement", () =>
  Effect.gen(function* () {
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    const entry = yield* catalog.admit(fixture);
    const task = "Use ($managed:reel-review), please.";
    expect(yield* catalog.candidates({ task, cwd: "/project" })).toEqual([]);
    yield* catalog.setEnabled({ ...entry, enabled: true });
    expect((yield* catalog.candidates({ task, cwd: "/project" })).map((s) => s.id)).toEqual([
      fixture.id,
    ]);
    expect(yield* catalog.candidates({ task, cwd: "/another" })).toEqual([]);
    expect(yield* catalog.candidates({ task: "Use $reel-review-extra.", cwd: "/project" })).toEqual(
      [],
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("does not let unavailable high-ranking matches hide usable skills", () =>
  Effect.gen(function* () {
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    for (let index = 0; index < 4; index++) {
      const entry = yield* catalog.admit({
        ...fixture,
        id: `reel-${index}`,
        dependencies:
          index < 3 ? [{ path: `/missing-workbench-fixture-${index}`, executable: false }] : [],
      });
      yield* catalog.setEnabled({ ...entry, enabled: true });
    }
    const found = yield* catalog.candidates({ task: "Review video reel", cwd: "/project" });
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({ id: "reel-3", missingDependencies: [] });
    const explicit = yield* catalog.candidates({
      task: "Review video reel using $reel-1.",
      cwd: "/project",
    });
    expect(explicit[0]?.id).toBe("reel-1");
    expect(explicit[0]?.missingDependencies).toHaveLength(1);
    expect(explicit[1]?.id).toBe("reel-3");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "indexes a skill library as disabled pointers and refuses a file that changed since",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-skill-library-" });
      const plugins = path.join(root, "..", "no-plugins-here");
      const write = (folder: string, text: string) =>
        fs
          .makeDirectory(path.join(root, folder), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(path.join(root, folder, "SKILL.md"), text)));
      yield* write(
        "reel-watch",
        "---\nname: reel-watch\ndescription: Review video reels.\n---\nSteps.",
      );
      yield* write("no-description", "---\nname: nothing\n---\nSteps.");
      yield* fs.makeDirectory(path.join(root, "not-a-skill"));

      expect(yield* catalog.syncLibrary({ enable: false, root, plugins })).toEqual({
        found: 2,
        added: 1,
        skipped: 1,
        enabled: 0,
      });
      expect(yield* catalog.candidates({ task: "review video reels", cwd: null })).toEqual([]);
      // A second pass finds nothing new, and enabling vouches for the library as it stands.
      expect(yield* catalog.syncLibrary({ enable: true, root, plugins })).toEqual({
        found: 2,
        added: 0,
        skipped: 1,
        enabled: 1,
      });
      // The judge sees every enabled skill, including for a task that shares no words with it.
      expect((yield* catalog.usable({ cwd: null })).map((skill) => skill.id)).toEqual([
        "reel-watch",
      ]);
      expect(yield* catalog.candidates({ task: "check my clip", cwd: null })).toEqual([]);
      const [entry] = yield* catalog.candidates({ task: "review video reels", cwd: null });
      const loaded = yield* catalog.load({ ...entry!, stage: "implement", cwd: null });
      expect(loaded.instructions).toContain(path.join(root, "reel-watch", "SKILL.md"));

      yield* write(
        "reel-watch",
        "---\nname: reel-watch\ndescription: Review video reels.\n---\nNew.",
      );
      expect(
        (yield* Effect.flip(catalog.load({ ...entry!, stage: "implement", cwd: null }))).reason,
      ).toBe("source_changed");
      expect((yield* catalog.syncLibrary({ enable: false, root, plugins })).added).toBe(1);

      // A downloaded skill sits beside the user's under its source's name. It stays off
      // through every ordinary sync and comes on only when its source is named.
      const downloaded = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-downloads-" });
      for (const folder of ["reel-watch", "mute-me"]) {
        yield* fs.makeDirectory(path.join(downloaded, "gsap", folder), { recursive: true });
        yield* fs.writeFileString(
          path.join(downloaded, "gsap", folder, "SKILL.md"),
          `---\nname: ${folder}\ndescription: Someone else's ${folder} skill.\n---\nSteps.`,
        );
      }
      const enabledIds = () =>
        catalog.list.pipe(
          Effect.map((all) =>
            all
              .filter((skill) => skill.enabled)
              .map((skill) => skill.id)
              .toSorted(),
          ),
        );
      yield* catalog.syncLibrary({ enable: false, root, plugins, downloaded });
      const muted = (yield* catalog.list).find((skill) => skill.id === "gsap-mute-me")!;
      yield* catalog.setEnabled({ id: muted.id, revision: muted.revision, enabled: true });
      yield* catalog.setEnabled({ id: muted.id, revision: muted.revision, enabled: false });
      yield* catalog.syncLibrary({ enable: true, root, plugins, downloaded });
      expect(yield* enabledIds()).toEqual(["reel-watch"]);
      // Another source's name turns on nothing; the user's mute still wins for its own source.
      yield* catalog.syncLibrary({
        enable: true,
        enableDownloaded: ["other"],
        root,
        plugins,
        downloaded,
      });
      expect(yield* enabledIds()).toEqual(["reel-watch"]);
      yield* catalog.syncLibrary({
        enable: true,
        enableDownloaded: ["gsap"],
        root,
        plugins,
        downloaded,
      });
      expect(yield* enabledIds()).toEqual(["gsap-reel-watch", "reel-watch"]);
    }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "indexes installed plugin skills once, from the newest version, and enables them on request",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-plugins-" });
      const root = path.join(base, "own");
      yield* fs.makeDirectory(root);
      const plugins = path.join(base, "plugins");
      const skill = (
        marketplace: string,
        plugin: string,
        version: string,
        name: string,
        text: string,
      ) => {
        const folder = path.join(plugins, "cache", marketplace, plugin, version, "skills", name);
        return fs
          .makeDirectory(folder, { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(path.join(folder, "SKILL.md"), text)));
      };
      const age = (marketplace: string, plugin: string, version: string, seconds: number) =>
        fs.utimes(path.join(plugins, "cache", marketplace, plugin, version), seconds, seconds);
      const body = (description: string) =>
        `---\nname: x\ndescription: ${description}\n---\nSteps.`;
      yield* skill("market", "gcloud-tools", "1.0.0", "setup", body("Old setup."));
      yield* skill("market", "gcloud-tools", "2.0.4", "setup", body("Set up gcloud."));
      yield* skill("market", "gcloud-tools", "2.0.4", "usage", body("Use gcloud."));
      yield* age("market", "gcloud-tools", "1.0.0", 1_000);
      yield* age("market", "gcloud-tools", "2.0.4", 2_000);
      yield* skill("market", "Odd Plugin!", "abc123", "A_Skill", body("Odd names."));
      yield* skill("market", "no-desc", "1", "empty", "---\nname: x\n---\n");
      // A marketplace checkout lists plugins that are not installed; it is not read.
      yield* fs.makeDirectory(path.join(plugins, "marketplaces", "m", "skills", "listed"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(plugins, "marketplaces", "m", "skills", "listed", "SKILL.md"),
        body("Only listed."),
      );

      expect(yield* catalog.syncLibrary({ enable: false, root, plugins })).toMatchObject({
        found: 4,
        added: 3,
        skipped: 1,
        enabled: 0,
      });
      const listed = yield* catalog.list;
      expect(listed.map((entry) => entry.id).toSorted()).toEqual([
        "plugin-gcloud-tools-setup",
        "plugin-gcloud-tools-usage",
        "plugin-odd-plugin-a-skill",
      ]);
      const setup = listed.find((entry) => entry.id === "plugin-gcloud-tools-setup")!;
      expect(setup).toMatchObject({
        name: "gcloud-tools:setup",
        description: "Set up gcloud.",
        source: "plugin-library:gcloud-tools/setup/SKILL.md",
        enabled: false,
      });
      expect(setup.dependencies[0]?.path).toContain(
        path.join("2.0.4", "skills", "setup", "SKILL.md"),
      );

      expect(yield* catalog.syncLibrary({ enable: true, root, plugins })).toMatchObject({
        added: 0,
        enabled: 3,
      });
      expect((yield* catalog.usable({ cwd: null })).map((entry) => entry.id).toSorted()).toEqual([
        "plugin-gcloud-tools-setup",
        "plugin-gcloud-tools-usage",
        "plugin-odd-plugin-a-skill",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("never turns a skill back on after the user switched it off, even when it changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-optout-" });
    const root = path.join(base, "own");
    const plugins = path.join(base, "plugins");
    const write = (folder: string, text: string) =>
      fs
        .makeDirectory(path.join(root, folder), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(root, folder, "SKILL.md"), text)));
    const body = (version: string) =>
      `---\nname: x\ndescription: Does things ${version}.\n---\nBody`;
    yield* write("keep", body("one"));
    yield* write("mute", body("one"));
    yield* catalog.syncLibrary({ enable: true, root, plugins });
    const enabledIds = () =>
      catalog.list.pipe(
        Effect.map((all) =>
          all
            .filter((skill) => skill.enabled)
            .map((skill) => skill.id)
            .toSorted(),
        ),
      );
    expect(yield* enabledIds()).toEqual(["keep", "mute"]);

    const mute = (yield* catalog.list).find((skill) => skill.id === "mute")!;
    yield* catalog.setEnabled({ id: "mute", revision: mute.revision, enabled: false });
    yield* catalog.syncLibrary({ enable: true, root, plugins });
    expect(yield* enabledIds()).toEqual(["keep"]);

    // A new revision of a muted skill stays off; a new revision of an enabled one replaces it.
    yield* write("mute", body("two"));
    yield* write("keep", body("two"));
    yield* catalog.syncLibrary({ enable: true, root, plugins });
    expect(yield* enabledIds()).toEqual(["keep"]);
    expect((yield* catalog.list).filter((skill) => skill.id === "mute")).toHaveLength(2);

    // Turning it on by hand is the way back, and a later sync keeps it.
    const latest = (yield* catalog.list).filter((skill) => skill.id === "mute").at(-1)!;
    yield* catalog.setEnabled({ id: "mute", revision: latest.revision, enabled: true });
    yield* catalog.syncLibrary({ enable: true, root, plugins });
    expect(yield* enabledIds()).toEqual(["keep", "mute"]);
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.live(
  "signals once a skill file appears in either watched folder, and ignores node_modules",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-skill-watch-" });
      const root = path.join(base, "skills");
      const plugins = path.join(base, "plugins");
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.makeDirectory(path.join(plugins, "cache", "market", "tool", "1", "skills"), {
        recursive: true,
      });
      // A burst only signals once it goes quiet, so the writes are spaced wider than the quiet time.
      const changed = (folder: string, file: string) =>
        catalog.libraryChanges({ root, plugins, quiet: "50 millis" }).pipe(
          Stream.take(1),
          Stream.runDrain,
          // The watch starts when the stream runs, so keep writing until it has seen a change.
          Effect.raceFirst(
            Effect.gen(function* () {
              for (let attempt = 0; ; attempt++) {
                yield* Effect.sleep("100 millis");
                yield* fs.makeDirectory(path.join(folder, `skill-${attempt}`), { recursive: true });
                yield* fs.writeFileString(
                  path.join(folder, `skill-${attempt}`, file),
                  `${attempt}`,
                );
              }
            }),
          ),
          Effect.timeout("10 seconds"),
        );
      yield* changed(root, "SKILL.md");
      yield* changed(path.join(plugins, "cache", "market", "tool", "1", "skills"), "SKILL.md");

      // Churn inside a dependency folder is not a skill change.
      const quiet = yield* catalog.libraryChanges({ root, plugins, quiet: "50 millis" }).pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.raceFirst(
          Effect.gen(function* () {
            yield* Effect.sleep("100 millis");
            for (let attempt = 0; attempt < 5; attempt++) {
              yield* fs.makeDirectory(path.join(root, "node_modules", `dep-${attempt}`), {
                recursive: true,
              });
              yield* fs.writeFileString(
                path.join(root, "node_modules", `dep-${attempt}`, "x"),
                "x",
              );
              yield* Effect.sleep("40 millis");
            }
            return "quiet" as const;
          }),
        ),
      );
      expect(quiet).toBe("quiet");
    }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
