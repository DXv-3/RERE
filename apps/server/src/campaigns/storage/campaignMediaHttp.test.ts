// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, expect, it } from "vite-plus/test";

import { campaignMediaRouteLayer } from "./campaignMediaHttp.ts";
import * as CampaignMediaLinks from "./CampaignMediaLinks.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = () => {
  const opened: string[] = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    campaignMediaRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(CampaignMediaLinks.CampaignMediaLinks, {
          open: ({ token }: { readonly token: string }) => {
            opened.push(token);
            return Effect.succeed({ _tag: "NotFound" } as const);
          },
        } as unknown as CampaignMediaLinks.CampaignMediaLinks["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, opened };
};

// The public media address is where a platform fetches a post's file. It is a read-only window
// onto files registered for a post; it must never be a way to start a picture or a video.
it("only reads: no method but GET (and HEAD) reaches the link lookup", async () => {
  const { handler, opened } = fixture();
  const url =
    "http://t3.test/api/campaign-media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/clip.mp4";
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await handler(
      new Request(url, { method, body: JSON.stringify({ prompt: "a cake", kind: "video" }) }),
    );
    await response.text();
    expect(response.status, method).toBeGreaterThanOrEqual(400);
    expect(response.status, method).not.toBe(200);
  }
  expect(opened).toEqual([]);
  const read = await handler(new Request(url));
  expect(read.status).toBe(404);
  expect(opened).toHaveLength(1);
});

it("the media route code does not import the campaign generation code", () => {
  const source = NodeFS.readFileSync(new URL("./campaignMediaHttp.ts", import.meta.url), "utf8");
  const imports = source
    .split("\n")
    .filter((line) => line.startsWith("import ") || line.startsWith("} from "))
    .join("\n");
  expect(imports).not.toMatch(/generation|LocalGpu|GenerationService/i);
});
