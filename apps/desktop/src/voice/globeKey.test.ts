import { expect, it } from "vite-plus/test";

import { parseGlobeKeyAction } from "./globeKey.ts";

it("reads what macOS does with the Globe key", () => {
  expect(parseGlobeKeyAction("0\n")).toBe("nothing");
  expect(parseGlobeKeyAction("1")).toBe("input-source");
  expect(parseGlobeKeyAction(" 2 ")).toBe("emoji");
  expect(parseGlobeKeyAction("3")).toBe("dictation");
  expect(parseGlobeKeyAction("")).toBe("unknown");
  expect(parseGlobeKeyAction("9")).toBe("unknown");
});
