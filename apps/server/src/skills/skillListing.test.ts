import { expect, it } from "vite-plus/test";

import { leadingSlashName } from "./explicitSkillNames.ts";
import { hidesSkillListing } from "./skillListing.ts";

it("hides a provider's own skill list only when Auto attaches skills per message", () => {
  expect(hidesSkillListing({ skillListing: "selected", routingMode: "automatic" })).toBe(true);
  expect(hidesSkillListing({ skillListing: "selected", routingMode: "manual" })).toBe(false);
  expect(hidesSkillListing({ skillListing: "all", routingMode: "automatic" })).toBe(false);
});

it("reads a leading /name and nothing else", () => {
  expect(leadingSlashName("/qa check the login")).toBe("qa");
  expect(leadingSlashName("  /Plugin:Skill")).toBe("plugin:skill");
  expect(leadingSlashName("please /qa")).toBeNull();
  expect(leadingSlashName("/path/to/file")).toBeNull();
  expect(leadingSlashName("//qa")).toBeNull();
  expect(leadingSlashName("/")).toBeNull();
});
