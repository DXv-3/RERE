import { describe, expect, it } from "vite-plus/test";

import {
  isLegalDocumentUrl,
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  SUPPORT_URL,
} from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it("opens CodeWrench's privacy policy from the Legal screen", () => {
    expect(LEGAL_URL).toBe(PRIVACY_POLICY_URL);
  });

  it.each([
    PRIVACY_POLICY_URL,
    `${PRIVACY_POLICY_URL}/`,
    `${PRIVACY_POLICY_URL}?source=app`,
    SUPPORT_URL,
    `${SUPPORT_URL}#contact`,
  ])("allows a CodeWrench legal page: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://savagesolutions.io/codewrench/download",
    "https://t3.codes/privacy-policy",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
