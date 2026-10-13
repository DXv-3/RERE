import { describe, expect, it } from "@effect/vitest";

import { amzDates, encodePath, sha256Hex, signRequest, uriEncode } from "./sigv4.ts";

// The credentials and requests below are the worked examples in AWS's documentation, "Signature
// Calculations for the Authorization Header" (Signature Version 4, Amazon S3). The signatures are
// the ones AWS publishes, so a match means this signer agrees with the service's own algorithm.
const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AT = Date.UTC(2013, 4, 24);
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SigV4 against AWS's published examples", () => {
  it("GET Object with a Range header", () => {
    const signed = signRequest({
      method: "GET",
      canonicalUri: "/test.txt",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_HASH,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY_HASH,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: "us-east-1",
      at: AT,
    });
    expect(signed.signature).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(signed.signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("PUT Object with a body and a storage class", () => {
    const body = "Welcome to Amazon S3.";
    const signed = signRequest({
      method: "PUT",
      canonicalUri: encodePath("/test$file.text"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": sha256Hex(body),
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: sha256Hex(body),
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: "us-east-1",
      at: AT,
    });
    expect(sha256Hex(body)).toBe(
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    );
    expect(signed.signature).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("GET bucket lifecycle, which has a query string", () => {
    const signed = signRequest({
      method: "GET",
      canonicalUri: "/",
      canonicalQuery: "lifecycle=",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": EMPTY_HASH,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY_HASH,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: "us-east-1",
      at: AT,
    });
    expect(signed.signature).toBe(
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });
});

describe("encoding and dates", () => {
  it("encodes every character outside the unreserved set, and keeps slashes in a path", () => {
    expect(uriEncode("a b/c!'()*~._-")).toBe("a%20b%2Fc%21%27%28%29%2A~._-");
    expect(encodePath("/bucket/campaigns/a b/clip (1).mp4")).toBe(
      "/bucket/campaigns/a%20b/clip%20%281%29.mp4",
    );
  });

  it("formats the two dates S3 wants", () => {
    expect(amzDates(Date.UTC(2026, 9, 6, 12, 34, 56, 789))).toEqual({
      amzDate: "20261006T123456Z",
      dateStamp: "20261006",
    });
  });
});
