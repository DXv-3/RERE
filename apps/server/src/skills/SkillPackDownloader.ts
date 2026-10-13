import { SkillPackError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ProcessRunner } from "../processRunner.ts";
import { repositorySlug, type SkillPackSource } from "./skillPacks.ts";

/** Puts the files of one pinned source (its skills folder and license) into an empty directory. */
export class SkillPackDownloader extends Context.Service<
  SkillPackDownloader,
  {
    readonly fetch: (
      source: SkillPackSource,
      directory: string,
    ) => Effect.Effect<void, SkillPackError>;
  }
>()("t3/skills/SkillPackDownloader") {}

const FETCH_TIMEOUT = "3 minutes";

/**
 * Downloads with `git`: a shallow, blob-less fetch of the pinned commit, then a sparse checkout of
 * only the skills folder and the license, so a large repository costs only the skills it holds.
 * Hooks, templates and prompts are switched off; the commit is a full sha, so a branch moving
 * upstream changes nothing.
 */
const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fetchSource = Effect.fn("SkillPackDownloader.fetch")(function* (
    source: SkillPackSource,
    directory: string,
  ) {
    // Defence in depth: the pack list is checked in tests, and a URL outside it never reaches git.
    if (repositorySlug(source.repositoryUrl) === null)
      return yield* new SkillPackError({ reason: "unknown_pack" });
    const git = (args: readonly string[], timeout: "30 seconds" | typeof FETCH_TIMEOUT) =>
      runner
        .run({
          command: "git",
          args: ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...args],
          cwd: directory,
          timeout,
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
          // Added to the host environment: a missing credential fails at once instead of prompting.
          env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SkillPackError({
                // A command that cannot start means git is not installed.
                reason: error._tag === "ProcessSpawnError" ? "git_missing" : "download_failed",
              }),
          ),
          Effect.flatMap((output) =>
            output.code === 0 && !output.timedOut
              ? Effect.void
              : Effect.fail(new SkillPackError({ reason: "download_failed" })),
          ),
        );
    yield* git(["init", "--quiet", "--template="], "30 seconds");
    yield* git(["remote", "add", "origin", source.repositoryUrl], "30 seconds");
    yield* git(
      ["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", source.commit],
      FETCH_TIMEOUT,
    );
    yield* git(["config", "core.sparseCheckout", "true"], "30 seconds");
    // `--template=` leaves no `info` folder, so it is made before the patterns are written.
    const info = path.join(directory, ".git", "info");
    yield* fs.makeDirectory(info, { recursive: true }).pipe(
      Effect.andThen(
        fs.writeFileString(
          path.join(info, "sparse-checkout"),
          `/${source.skillsPath}/\n/${source.licenseFile}\n`,
        ),
      ),
      Effect.mapError(() => new SkillPackError({ reason: "storage" })),
    );
    yield* git(["checkout", "--quiet", "FETCH_HEAD"], FETCH_TIMEOUT);
  });
  return SkillPackDownloader.of({ fetch: fetchSource });
});

export const layer = Layer.effect(SkillPackDownloader, make);
