import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vite-plus/test";

import { oidcJwksUrl, verifyOidcAccessToken } from "./OidcTokens.ts";

const settings = {
  oidcIssuer: "https://login.example.test/realms/codewrench",
  oidcAudience: "codewrench-relay",
};

/** A local key pair stands in for the sign-in provider. */
async function provider() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  const sign = (claims: { sub?: string; aud?: string; iss?: string; expiresIn?: string }) => {
    const builder = new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(claims.iss ?? settings.oidcIssuer)
      .setAudience(claims.aud ?? settings.oidcAudience)
      .setIssuedAt()
      .setExpirationTime(claims.expiresIn ?? "5m");
    if (claims.sub !== undefined) builder.setSubject(claims.sub);
    return builder.sign(privateKey);
  };
  return { keys: createLocalJWKSet({ keys: [jwk] }), sign };
}

describe("verifyOidcAccessToken", () => {
  it("returns the subject of a token issued for the relay", async () => {
    const { keys, sign } = await provider();
    await expect(
      verifyOidcAccessToken(settings, await sign({ sub: "user-1" }), keys),
    ).resolves.toMatchObject({ sub: "user-1" });
  });

  it("refuses a token for another audience, issuer or signer, or one that expired", async () => {
    const { keys, sign } = await provider();
    const stranger = await provider();
    const refused = [
      await sign({ sub: "user-1", aud: "some-other-app" }),
      await sign({ sub: "user-1", iss: "https://login.example.test/realms/other" }),
      await stranger.sign({ sub: "user-1" }),
      await sign({ sub: "user-1", expiresIn: "-1m" }),
      await sign({}),
    ];
    for (const token of refused) {
      await expect(verifyOidcAccessToken(settings, token, keys)).rejects.toThrow();
    }
  });

  it("reads signing keys from the realm's certs endpoint", () => {
    expect(oidcJwksUrl(`${settings.oidcIssuer}/`).toString()).toBe(
      "https://login.example.test/realms/codewrench/protocol/openid-connect/certs",
    );
  });
});
