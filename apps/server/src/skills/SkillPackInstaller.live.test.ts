import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ManagedSkillCatalog from "./ManagedSkillCatalog.ts";
import * as SkillPackDownloader from "./SkillPackDownloader.ts";
import { makeInstaller } from "./SkillPackInstaller.ts";
import { SKILL_PACKS } from "./skillPacks.ts";

// Downloads every shipped pack from GitHub with the real git. Off by default; run with
// SKILL_PACKS_LIVE=1 to check that the pinned commits still exist and hold their skills.
const live = process.env.SKILL_PACKS_LIVE === "1";

const layer = Layer.mergeAll(
  ManagedSkillCatalog.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
  SkillPackDownloader.layer.pipe(Layer.provide(ProcessRunner.layer)),
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

it.effect.skipIf(!live)(
  "installs every shipped pack from the network, each skill with a SKILL.md",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skill-packs-live-" });
        const library = path.join(home, "skill-library");
        const installer = yield* makeInstaller({
          library,
          root: path.join(home, "none"),
          plugins: path.join(home, "none"),
        });
        for (const pack of SKILL_PACKS) {
          const summary = yield* installer.install(pack.id);
          const expected = pack.sources.reduce((n, s) => n + (s.include?.length ?? 0), 0);
          expect(summary.skillCount).toBe(expected);
          for (const source of pack.sources) {
            for (const skill of source.include ?? [])
              expect(yield* fs.exists(path.join(library, source.id, skill, "SKILL.md"))).toBe(true);
            expect(yield* fs.exists(path.join(library, source.id, `LICENSE-${source.id}`))).toBe(
              true,
            );
          }
        }
        const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
        const skills = yield* catalog.list;
        expect(skills.length).toBeGreaterThan(0);
        expect(skills.every((skill) => skill.enabled)).toBe(true);
        for (const pack of SKILL_PACKS) yield* installer.remove(pack.id);
        expect(yield* fs.readDirectory(library)).toEqual(["SOURCES.md", "installed-packs.json"]);
      }),
    ).pipe(Effect.provide(layer)),
  { timeout: 600_000 },
);
