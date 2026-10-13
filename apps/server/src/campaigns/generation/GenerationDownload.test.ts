import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it as plainIt } from "vite-plus/test";

import { downloadResult, extensionForContentType, isPublicHttpsUrl } from "./GenerationDownload.ts";

const httpReturning = (make: () => Response) => {
  let calls = 0;
  const http = HttpClient.make((req) => {
    calls += 1;
    return Effect.succeed(HttpClientResponse.fromWeb(req, make()));
  });
  return { http, calls: () => calls };
};

const withDir = <A, E>(
  use: (
    dir: string,
    fileSystem: FileSystem.FileSystem,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    return yield* use(dir, fileSystem);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("addresses and content types", () => {
  plainIt("accepts only public https addresses", () => {
    expect(isPublicHttpsUrl("https://cdn.example.com/a.mp4")).toBe(true);
    for (const bad of [
      "http://cdn.example.com/a.mp4",
      "https://localhost/a",
      "https://127.0.0.1/a",
      "https://10.0.0.5/a",
      "https://192.168.1.2/a",
      "https://172.20.1.1/a",
      "https://169.254.169.254/latest",
      "https://[::1]/a",
      "https://user:pw@cdn.example.com/a",
      "file:///etc/passwd",
      "nonsense",
    ]) {
      expect(isPublicHttpsUrl(bad), bad).toBe(false);
    }
  });
  plainIt("maps image and video types to extensions and refuses the rest", () => {
    expect(extensionForContentType("image/png")).toBe("png");
    expect(extensionForContentType("video/mp4; codecs=avc1")).toBe("mp4");
    expect(extensionForContentType("text/html")).toBeNull();
    expect(extensionForContentType("application/octet-stream")).toBeNull();
    expect(extensionForContentType(undefined)).toBeNull();
  });
});

it.effect("saves an https video next to the base name and leaves no partial file", () =>
  withDir((dir, fileSystem) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { http } = httpReturning(
        () =>
          new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4" } }),
      );
      const done = yield* downloadResult(
        { http, fileSystem },
        "https://cdn.example.com/v.mp4",
        path.join(dir, "job-1"),
      );
      assert.deepStrictEqual(done, { extension: "mp4", bytes: 4 });
      assert.deepStrictEqual([...(yield* fileSystem.readDirectory(dir))], ["job-1.mp4"]);
    }),
  ),
);

it.effect("refuses what is not an image or video, a private address, and a failed download", () =>
  withDir((dir, fileSystem) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const html = httpReturning(
        () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      );
      assert.include(
        yield* Effect.flip(
          downloadResult(
            { http: html.http, fileSystem },
            "https://cdn.example.com/x",
            path.join(dir, "a"),
          ),
        ),
        "not an image or video",
      );
      assert.include(
        yield* Effect.flip(
          downloadResult(
            { http: html.http, fileSystem },
            "https://127.0.0.1/x",
            path.join(dir, "a"),
          ),
        ),
        "not a public https link",
      );
      assert.strictEqual(html.calls(), 1);
      const missing = httpReturning(() => new Response("no", { status: 404 }));
      assert.include(
        yield* Effect.flip(
          downloadResult(
            { http: missing.http, fileSystem },
            "https://cdn.example.com/x",
            path.join(dir, "a"),
          ),
        ),
        "HTTP 404",
      );
      assert.deepStrictEqual([...(yield* fileSystem.readDirectory(dir))], []);
    }),
  ),
);

it.effect("stops at the size limit and removes the partial file", () =>
  withDir((dir, fileSystem) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { http } = httpReturning(
        () => new Response(new Uint8Array(2048), { headers: { "content-type": "video/mp4" } }),
      );
      const error = yield* Effect.flip(
        downloadResult(
          { http, fileSystem },
          "https://cdn.example.com/big.mp4",
          path.join(dir, "j"),
          {
            maxBytes: 1024,
          },
        ),
      );
      assert.include(error, "larger than");
      assert.deepStrictEqual([...(yield* fileSystem.readDirectory(dir))], []);
    }),
  ),
);

it.effect("decodes an inline image, and refuses an inline file that is not an image", () =>
  withDir((dir, fileSystem) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { http, calls } = httpReturning(() => new Response("unused"));
      const done = yield* downloadResult(
        { http, fileSystem },
        `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`,
        path.join(dir, "img"),
      );
      assert.deepStrictEqual(done, { extension: "png", bytes: 7 });
      assert.strictEqual(yield* fileSystem.readFileString(path.join(dir, "img.png")), "PNGDATA");
      assert.include(
        yield* Effect.flip(
          downloadResult({ http, fileSystem }, "data:text/html;base64,PGI+", path.join(dir, "x")),
        ),
        "not an image",
      );
      assert.strictEqual(calls(), 0);
    }),
  ),
);
