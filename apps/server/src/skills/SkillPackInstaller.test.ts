import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SkillPackError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ManagedSkillCatalog from "./ManagedSkillCatalog.ts";
import { SkillPackDownloader } from "./SkillPackDownloader.ts";
import { SkillPackInstaller, makeInstaller } from "./SkillPackInstaller.ts";
import type { SkillPack, SkillPackSource } from "./skillPacks.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sha = (digit: string) => digit.repeat(40);
const source = (
  id: string,
  commit: string,
  change: Partial<SkillPackSource> = {},
): SkillPackSource => ({
  id,
  repositoryUrl: `https://github.com/example/${id}`,
  commit,
  skillsPath: "skills",
  licenseFile: "LICENSE",
  licenseName: "MIT",
  ...change,
});
const pack = (id: string, sources: readonly SkillPackSource[]): SkillPack => ({
  id,
  title: id,
  description: `${id} pack`,
  sources,
});
const skillText = (name: string) =>
  `---\nname: ${name}\ndescription: Use for ${name} work.\n---\nBody of ${name}.\n`;

type Fake = (
  source: SkillPackSource,
  directory: string,
) => Effect.Effect<void, SkillPackError, FileSystem.FileSystem | Path.Path>;

/** A downloader that writes a made-up repository instead of reaching the network. */
const downloaderLayer = (behaviour: { current: Fake }) =>
  Layer.effect(
    SkillPackDownloader,
    Effect.gen(function* () {
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      return SkillPackDownloader.of({
        fetch: (target, directory) =>
          behaviour.current(target, directory).pipe(Effect.provide(context)),
      });
    }),
  );

const write = (directory: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(directory, name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, text);
    }
  }).pipe(Effect.mapError(() => new SkillPackError({ reason: "storage" })));

const repository =
  (label: string): Fake =>
  (_source, directory) =>
    write(directory, {
      "skills/alpha/SKILL.md": skillText("alpha"),
      "skills/alpha/references/notes.md": `notes ${label}`,
      "skills/beta/SKILL.md": skillText("beta"),
      "skills/no-skill-file/readme.md": "not a skill",
      LICENSE: `license ${label}`,
    });

const catalogLayer = ManagedSkillCatalog.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

/** One installer over a fresh temp library, with the given downloader behaviour. */
const withInstaller = <A, E>(
  packs: readonly SkillPack[],
  behaviour: { current: Fake },
  use: (input: {
    installer: SkillPackInstaller["Service"];
    library: string;
  }) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ManagedSkillCatalog.ManagedSkillCatalog
  >,
  limits: { maxBytes?: number; maxFiles?: number } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skill-packs-test-" });
      const library = path.join(home, "skill-library");
      const installer = yield* makeInstaller({
        library,
        root: path.join(home, "no-own-skills"),
        plugins: path.join(home, "no-plugins"),
        packs,
        ...limits,
      }).pipe(Effect.provide(downloaderLayer(behaviour)));
      return yield* use({ installer, library });
    }),
  ).pipe(Effect.provide(Layer.merge(catalogLayer, NodeServices.layer)));

const read = (file: string) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(Effect.orElseSucceed(() => null));
const exists = (file: string) => FileSystem.FileSystem.use((fs) => fs.exists(file));

it.effect(
  "installs a pack: skill folders, license, SOURCES.md, record, and turns the skills on",
  () =>
    withInstaller(
      [pack("demo", [source("alpha", sha("a"))])],
      { current: repository("a") },
      ({ installer, library }) =>
        Effect.gen(function* () {
          const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
          const before = (yield* installer.list)[0]!;
          expect(before).toMatchObject({ installed: false, skillCount: null });
          const summary = yield* installer.install("demo");
          expect(summary).toMatchObject({ installed: true, skillCount: 2, updateAvailable: false });
          expect(summary.sources[0]!.installedCommit).toBe(sha("a"));
          expect(yield* read(`${library}/alpha/alpha/SKILL.md`)).toBe(skillText("alpha"));
          expect(yield* read(`${library}/alpha/alpha/references/notes.md`)).toBe("notes a");
          expect(yield* exists(`${library}/alpha/no-skill-file`)).toBe(false);
          expect(yield* read(`${library}/alpha/LICENSE-alpha`)).toBe("license a");
          expect(yield* read(`${library}/SOURCES.md`)).toContain(
            "- `alpha/` — https://github.com/example/alpha @ aaaaaaaaaaaa — 2 skills — license: LICENSE",
          );
          expect(decodeJson((yield* read(`${library}/installed-packs.json`))!)).toEqual({
            packs: { demo: { alpha: { commit: sha("a"), skills: ["alpha", "beta"] } } },
          });
          const skills = yield* catalog.list;
          expect(skills.map((skill) => [skill.id, skill.enabled])).toEqual([
            ["alpha-alpha", true],
            ["alpha-beta", true],
          ]);
          // Installing again replaces the source in place and keeps one SOURCES.md line.
          yield* installer.install("demo");
          expect(((yield* read(`${library}/SOURCES.md`))!.match(/`alpha\/`/g) ?? []).length).toBe(
            1,
          );
          const left = yield* FileSystem.FileSystem.use((fs) => fs.readDirectory(library));
          expect(left.toSorted()).toEqual(["SOURCES.md", "alpha", "installed-packs.json"]);
        }),
    ),
);

let outsideDirectory = "";

it.effect("skips links in the download and never reads outside it", () =>
  withInstaller(
    [pack("demo", [source("alpha", sha("a"))])],
    {
      current: (target, directory) =>
        Effect.gen(function* () {
          yield* repository("a")(target, directory);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = yield* fs.makeTempDirectory({ prefix: "skill-packs-outside-" });
          outsideDirectory = outside;
          yield* write(outside, { "SKILL.md": skillText("stolen"), "secret.txt": "secret" });
          // A skill folder that is a link, and a link to a file inside a real skill folder.
          yield* fs.symlink(outside, path.join(directory, "skills", "linked"));
          yield* fs.symlink(
            path.join(outside, "secret.txt"),
            path.join(directory, "skills", "alpha", "secret.txt"),
          );
        }).pipe(Effect.mapError(() => new SkillPackError({ reason: "storage" }))),
    },
    ({ installer, library }) =>
      Effect.gen(function* () {
        const summary = yield* installer.install("demo");
        expect(summary.skillCount).toBe(2);
        expect(yield* exists(`${library}/alpha/linked`)).toBe(false);
        expect(yield* exists(`${library}/alpha/alpha/secret.txt`)).toBe(false);
        expect(yield* exists(`${library}/alpha/alpha/SKILL.md`)).toBe(true);
        yield* FileSystem.FileSystem.use((fs) =>
          fs.remove(outsideDirectory, { recursive: true, force: true }),
        );
      }),
  ),
);

it.effect(
  "refuses a pack whose definition climbs out of the repository or is not a pack at all",
  () =>
    withInstaller(
      [
        pack("climb", [source("alpha", sha("a"), { skillsPath: "../outside" })]),
        pack("evil", [source("alpha", sha("a"), { include: ["../evil"] })]),
        pack("web", [source("alpha", sha("a"), { repositoryUrl: "https://evil.example/a/b" })]),
      ],
      { current: repository("a") },
      ({ installer, library }) =>
        Effect.gen(function* () {
          for (const id of ["climb", "evil", "web", "unlisted"])
            expect((yield* Effect.flip(installer.install(id))).reason).toBe("unknown_pack");
          expect(yield* exists(library)).toBe(false);
        }),
    ),
);

it.effect("rejects a source over the size or file limit and leaves nothing behind", () =>
  Effect.gen(function* () {
    const packs = [pack("demo", [source("alpha", sha("a"))])];
    yield* withInstaller(
      packs,
      { current: repository("a") },
      ({ installer, library }) =>
        Effect.gen(function* () {
          expect((yield* Effect.flip(installer.install("demo"))).reason).toBe("too_large");
          expect(yield* exists(`${library}/alpha`)).toBe(false);
          const left = yield* FileSystem.FileSystem.use((fs) => fs.readDirectory(library));
          expect(left.filter((name) => name.startsWith("."))).toEqual([]);
          expect((yield* installer.list)[0]!.installed).toBe(false);
        }),
      { maxBytes: 20 },
    );
    yield* withInstaller(
      packs,
      { current: repository("a") },
      ({ installer }) =>
        Effect.flatMap(Effect.flip(installer.install("demo")), (error) =>
          Effect.sync(() => expect(error.reason).toBe("too_large")),
        ),
      { maxFiles: 2 },
    );
  }),
);

it.effect("a failed update leaves the previous copy and record intact", () => {
  const behaviour = { current: repository("old") };
  return withInstaller(
    [pack("demo", [source("alpha", sha("a"))])],
    behaviour,
    ({ installer, library }) =>
      Effect.gen(function* () {
        yield* installer.install("demo");
        behaviour.current = (_target, directory) =>
          Effect.gen(function* () {
            yield* write(directory, { "skills/alpha/SKILL.md": skillText("alpha") });
            return yield* new SkillPackError({ reason: "download_failed" });
          });
        expect((yield* Effect.flip(installer.install("demo"))).reason).toBe("download_failed");
        expect(yield* read(`${library}/alpha/alpha/references/notes.md`)).toBe("notes old");
        expect(yield* read(`${library}/alpha/LICENSE-alpha`)).toBe("license old");
        expect((yield* installer.list)[0]).toMatchObject({ installed: true, skillCount: 2 });
        // A pack with no skills at all fails the same way, before touching the old copy.
        behaviour.current = (_target, directory) => write(directory, { LICENSE: "x" });
        expect((yield* Effect.flip(installer.install("demo"))).reason).toBe("no_skills");
        expect(yield* read(`${library}/alpha/alpha/references/notes.md`)).toBe("notes old");
      }),
  );
});

it.effect("remove deletes only the folders its pack installed", () =>
  withInstaller(
    [
      pack("one", [source("alpha", sha("a")), source("shared", sha("c"))]),
      pack("two", [source("shared", sha("c")), source("gamma", sha("d"))]),
    ],
    { current: repository("x") },
    ({ installer, library }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The owner's own source folder and a stray file sit in the same library.
        yield* write(library, {
          "mine/handmade/SKILL.md": skillText("handmade"),
          "notes.txt": "keep",
        });
        yield* installer.install("one");
        yield* installer.install("two");
        const removed = yield* installer.remove("one");
        expect(removed.installed).toBe(false);
        expect(yield* exists(`${library}/alpha`)).toBe(false);
        // The shared source is still used by pack two.
        expect(yield* exists(`${library}/shared/alpha/SKILL.md`)).toBe(true);
        expect(yield* exists(`${library}/gamma`)).toBe(true);
        expect(yield* read(`${library}/mine/handmade/SKILL.md`)).toBe(skillText("handmade"));
        expect(yield* read(`${library}/notes.txt`)).toBe("keep");
        const sources = (yield* read(`${library}/SOURCES.md`))!;
        expect(sources).not.toContain("`alpha/`");
        expect(sources).toContain("`shared/`");
        yield* installer.remove("two");
        expect((yield* fs.readDirectory(library)).toSorted()).toEqual([
          "SOURCES.md",
          "installed-packs.json",
          "mine",
          "notes.txt",
        ]);
        expect((yield* Effect.flip(installer.remove("nope"))).reason).toBe("unknown_pack");
      }),
  ),
);

it.effect("a tampered record cannot make remove delete outside its folders", () =>
  withInstaller(
    [pack("one", [source("alpha", sha("a"))])],
    { current: repository("x") },
    ({ installer, library }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(path.dirname(library), "precious");
        yield* write(outside, { "keep.txt": "keep" });
        yield* write(library, {
          "installed-packs.json": encodeJson({
            packs: {
              one: {
                "../precious": { commit: sha("a"), skills: [] },
                "..": { commit: sha("a"), skills: [] },
              },
            },
          }),
        });
        yield* installer.remove("one");
        expect(yield* fs.exists(`${outside}/keep.txt`)).toBe(true);
        expect(yield* fs.exists(library)).toBe(true);
      }),
  ),
);
