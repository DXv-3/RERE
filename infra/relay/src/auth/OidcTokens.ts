// The verifier lives in the shared package so an environment server can use the same checks.
export {
  oidcJwksUrl,
  verifyOidcAccessToken,
  type OidcVerificationSettings,
} from "@t3tools/shared/oidcAccessToken";
