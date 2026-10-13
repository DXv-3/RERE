import * as DateTime from "effect/DateTime";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vite-plus/test";

import { verifyOidcAccessToken, type OidcVerificationOptions } from "./oidcAccessToken.ts";

const settings = {
  oidcIssuer: "https://login.example.test/realms/codewrench",
  oidcAudience: "codewrench-relay",
};

// Every token is issued at this fixed moment and judged against it, so no test reads the clock.
const NOW_SECONDS = 1_790_000_000;
const NOW = DateTime.toDate(DateTime.makeUnsafe(NOW_SECONDS * 1000));

async function provider() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  const sign = (input: {
    claims?: Record<string, unknown>;
    expiresAt?: number | null;
    notBefore?: number;
  }) => {
    const builder = new SignJWT({ typ: "Bearer", ...input.claims })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(settings.oidcIssuer)
      .setAudience(settings.oidcAudience)
      .setSubject("user-1")
      .setIssuedAt(NOW_SECONDS);
    if (input.expiresAt !== null) builder.setExpirationTime(input.expiresAt ?? NOW_SECONDS + 300);
    if (input.notBefore !== undefined) builder.setNotBefore(input.notBefore);
    return builder.sign(privateKey);
  };
  return { keys: createLocalJWKSet({ keys: [jwk] }), sign };
}

const verify = (
  token: string,
  keys: Parameters<typeof verifyOidcAccessToken>[2],
  options: OidcVerificationOptions = {},
) => verifyOidcAccessToken(settings, token, keys, { now: NOW, ...options });

describe("verifyOidcAccessToken options", () => {
  it("refuses a token with no expiry", async () => {
    const { keys, sign } = await provider();
    await expect(verify(await sign({ expiresAt: null }), keys)).rejects.toThrow();
  });

  it("accepts only Bearer tokens when asked, and any type otherwise", async () => {
    const { keys, sign } = await provider();
    const idToken = await sign({ claims: { typ: "ID" } });
    await expect(verify(idToken, keys, { requireBearerType: true })).rejects.toThrow(
      "not_an_access_token",
    );
    await expect(verify(idToken, keys)).resolves.toMatchObject({
      sub: "user-1",
    });
    const noType = await sign({ claims: { typ: undefined } });
    await expect(verify(noType, keys, { requireBearerType: true })).rejects.toThrow(
      "not_an_access_token",
    );
  });

  it("applies the clock tolerance to expiry and not-before", async () => {
    const { keys, sign } = await provider();
    const nowSeconds = NOW_SECONDS;
    const justExpired = await sign({ expiresAt: nowSeconds - 10 });
    await expect(verify(justExpired, keys)).rejects.toThrow();
    await expect(verify(justExpired, keys, { clockToleranceSeconds: 30 })).resolves.toMatchObject({
      sub: "user-1",
    });
    const longExpired = await sign({ expiresAt: nowSeconds - 120 });
    await expect(verify(longExpired, keys, { clockToleranceSeconds: 30 })).rejects.toThrow();
    const notYet = await sign({ notBefore: nowSeconds + 10 });
    await expect(verify(notYet, keys)).rejects.toThrow();
    await expect(verify(notYet, keys, { clockToleranceSeconds: 30 })).resolves.toMatchObject({
      sub: "user-1",
    });
  });

  it("judges expiry against the supplied clock", async () => {
    const { keys, sign } = await provider();
    const token = await sign({});
    const later = DateTime.toDate(DateTime.makeUnsafe((NOW_SECONDS + 3600) * 1000));
    await expect(verify(token, keys, { now: later })).rejects.toThrow();
  });
});

describe("verifyOidcAccessToken email claims", () => {
  it("returns a lower-cased address and whether the provider verified it", async () => {
    const { keys, sign } = await provider();
    await expect(
      verify(await sign({ claims: { email: " Sam@Example.COM ", email_verified: true } }), keys),
    ).resolves.toEqual({
      sub: "user-1",
      email: "sam@example.com",
      emailVerified: true,
      firstName: null,
    });
  });

  it("treats anything but a literal true as unverified", async () => {
    const { keys, sign } = await provider();
    for (const email_verified of [false, "true", 1, undefined]) {
      await expect(
        verify(await sign({ claims: { email: "sam@example.com", email_verified } }), keys),
      ).resolves.toMatchObject({ emailVerified: false });
    }
    await expect(verify(await sign({}), keys)).resolves.toEqual({
      sub: "user-1",
      email: null,
      emailVerified: false,
      firstName: null,
    });
  });
});

describe("verifyOidcAccessToken first name", () => {
  const firstNameOf = async (claims: Record<string, unknown>) => {
    const { keys, sign } = await provider();
    return (await verify(await sign({ claims }), keys)).firstName;
  };

  it("prefers given_name, then the first word of name, and is null otherwise", async () => {
    expect(await firstNameOf({ given_name: "Sam", name: "Samuel Jones" })).toBe("Sam");
    expect(await firstNameOf({ name: "  Samuel   Jones " })).toBe("Samuel");
    expect(await firstNameOf({ given_name: "   ", name: "Priya Patel" })).toBe("Priya");
    expect(await firstNameOf({})).toBeNull();
    expect(await firstNameOf({ given_name: 42, name: ["Sam"] })).toBeNull();
    expect(await firstNameOf({ given_name: " \t\n ", name: "" })).toBeNull();
  });

  it("keeps it to one line of at most 60 characters", async () => {
    expect(await firstNameOf({ given_name: "Mary\r\nBcc: x@example.com" })).toBe(
      "Mary Bcc: x@example.com",
    );
    expect(await firstNameOf({ given_name: "x".repeat(200) })).toBe("x".repeat(60));
  });
});
