/** CodeWrench's own pages. They must be published at these addresses before the app is submitted. */
export const PRIVACY_POLICY_URL = "https://savagesolutions.io/codewrench/privacy";
export const SUPPORT_URL = "https://savagesolutions.io/codewrench/support";

/** What the Legal screen opens. */
export const LEGAL_URL = PRIVACY_POLICY_URL;

export const ALLOWED_LEGAL_DOCUMENT_URLS = [PRIVACY_POLICY_URL, SUPPORT_URL] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
