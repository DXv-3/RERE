// @effect-diagnostics nodeBuiltinImport:off -- walks the source tree with Node.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

/**
 * macOS and Windows treat `Foo.tsx` and `foo.ts` as the same import path, so a pair like that
 * builds on Linux and fails (or imports the wrong file) on a Mac. Keep every module name in a
 * folder distinct without relying on letter case.
 */
it("has no two modules in a folder whose names differ only by letter case", () => {
  const root = NodePath.join(import.meta.dirname);
  const clashes: string[] = [];
  const walk = (directory: string) => {
    const seen = new Map<string, string>();
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(NodePath.join(directory, entry.name));
        continue;
      }
      const module = entry.name.replace(/\.(tsx|ts|css)$/, "");
      if (module === entry.name) continue;
      const earlier = seen.get(module.toLowerCase());
      if (earlier !== undefined && earlier !== module) {
        clashes.push(NodePath.relative(root, NodePath.join(directory, `${earlier} / ${module}`)));
      }
      seen.set(module.toLowerCase(), module);
    }
  };
  walk(root);
  expect(clashes).toEqual([]);
});
