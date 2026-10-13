import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/**
 * Finds one of the graphics card scripts. In the built server it sits next to the bundle
 * (`dist/localgen`, copied there by the build); from source it is in the server package's
 * `resources`. The image script is `generate_image.py`, the video script `generate_video.py`.
 */
export const locateLocalGpuScript = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  here: string = import.meta.dirname,
  name: "generate_image.py" | "generate_video.py" = "generate_image.py",
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const candidates = [
      path.join(here, "localgen", name),
      path.join(here, "../localgen", name),
      path.join(here, "../../../resources/localgen", name),
      path.join(here, "../resources/localgen", name),
    ];
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return null;
  });
