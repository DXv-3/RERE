import { expect, it } from "vite-plus/test";
import { createBellScanner } from "./terminalBell";

it("hears a bell but not the BEL that ends a title sequence", () => {
  const scan = createBellScanner();
  expect(scan("done\x07")).toBe(true);
  expect(scan("\x1b]0;~/project\x07$ ")).toBe(false);
  expect(scan("\x1b]0;title\x1b\\prompt")).toBe(false);
  expect(scan("\x1b]0;title\x07 then \x07")).toBe(true);
});

it("keeps a title sequence open across chunks", () => {
  const scan = createBellScanner();
  expect(scan("\x1b]0;long ti")).toBe(false);
  expect(scan("tle\x07")).toBe(false);
  expect(scan("\x07")).toBe(true);
  expect(scan("text\x1b")).toBe(false);
  expect(scan("]2;x\x07")).toBe(false);
});
