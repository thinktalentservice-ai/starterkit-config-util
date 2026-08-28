import { describe, expect, it } from "vitest";
import { decompressFflate } from "@devopsthink/react-security-util";
import { buildCompressedPayload } from "./payload.js";

describe("buildCompressedPayload", () => {
  it("produces the exact request body the Java services expect", () => {
    const body = buildCompressedPayload({ userId: 7, name: "x" });
    // A STRING, already stringified - that is what the call sites hand to
    // fetch's `body`. Returning the object and letting each caller stringify
    // would be tidier and would also let one of them forget.
    expect(typeof body).toBe("string");

    const parsed = JSON.parse(body) as { payload: string };
    expect(Object.keys(parsed)).toEqual(["payload"]);
    expect(JSON.parse(decompressFflate(parsed.payload) as string)).toEqual({
      userId: 7,
      name: "x",
    });
  });

  it("round-trips a string input without double-encoding it into an object", () => {
    const parsed = JSON.parse(buildCompressedPayload("plain")) as { payload: string };
    expect(JSON.parse(decompressFflate(parsed.payload) as string)).toBe("plain");
  });

  it("actually compresses - the payload is not the plaintext", () => {
    const parsed = JSON.parse(buildCompressedPayload({ canary: "uncompressed-marker" })) as {
      payload: string;
    };
    expect(parsed.payload).not.toContain("uncompressed-marker");
  });
});
