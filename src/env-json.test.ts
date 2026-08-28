import { describe, expect, it } from "vitest";
import { CryptoEncryption } from "@devopsthink/react-security-util";
import { decodeEnvJson, unknownKeys } from "./env-json.js";

const encode = (obj: unknown): string =>
  JSON.stringify({ configEnv: CryptoEncryption.encrypt(JSON.stringify(obj)) });

describe("decodeEnvJson", () => {
  it("decrypts configEnv and returns the keys VERBATIM", () => {
    // The contract in one assertion: whoever writes env.json writes the key the
    // code reads. No camelCase transform, no lookup table - both of which fail
    // in the direction nobody notices, by landing the value under a name nothing
    // reads while looking like they worked.
    const { overrides, keys } = decodeEnvJson(
      encode({ INTEGRATION_ALLOWED_DOMAINS: "a.example", IDLE_TIME: 3600 }),
    );
    expect(overrides).toEqual({ INTEGRATION_ALLOWED_DOMAINS: "a.example", IDLE_TIME: 3600 });
    expect(keys).toEqual(["INTEGRATION_ALLOWED_DOMAINS", "IDLE_TIME"]);
  });

  it("falls back to a plaintext envVariables object when configEnv is absent", () => {
    // The docker/express variant of this endpoint serves both; the static file
    // serves only configEnv.
    const { overrides } = decodeEnvJson(JSON.stringify({ envVariables: { IDLE_TIME: 60 } }));
    expect(overrides).toEqual({ IDLE_TIME: 60 });
  });

  it("prefers configEnv when both are present, so they cannot disagree", () => {
    const both = JSON.parse(encode({ IDLE_TIME: 1 })) as Record<string, unknown>;
    both["envVariables"] = { IDLE_TIME: 999 };
    expect(decodeEnvJson(JSON.stringify(both)).overrides["IDLE_TIME"]).toBe(1);
  });

  it("keeps null, which an operator can mean, and drops undefined, which they cannot", () => {
    const { overrides, keys } = decodeEnvJson(encode({ A: null, B: undefined, C: 0, D: "" }));
    expect(overrides).toEqual({ A: null, C: 0, D: "" });
    // "env.json set this" stays true of every key that survives.
    expect(keys).not.toContain("B");
  });

  // A silent {} is indistinguishable from "env.json legitimately overrides
  // nothing", which is the state this mechanism exists to be able to observe.
  it.each([
    ["not JSON at all", "{oops", /not valid JSON/],
    ["a JSON array", "[]", /must be a JSON object/],
    ["an object with neither field", "{}", /no .configEnv. string and no .envVariables. object/],
    ["an empty configEnv", '{"configEnv":"   "}', /no .configEnv. string/],
    ["an undecryptable blob", '{"configEnv":"not-a-real-blob"}', /did not decrypt|not JSON/],
  ])("throws on %s rather than returning an empty object", (_label, input, pattern) => {
    expect(() => decodeEnvJson(input)).toThrow(pattern as RegExp);
  });

  it("throws when configEnv decrypts to something that is not an object", () => {
    expect(() => decodeEnvJson(encode(["a", "b"]))).toThrow(/must decrypt to a JSON object/);
    expect(() => decodeEnvJson(encode("a string"))).toThrow(/must decrypt to a JSON object/);
  });
});

describe("unknownKeys", () => {
  it("reports keys the app does not declare - a warning, never an error", () => {
    // The usual cause is a payload still written in a Vite app's dialect
    // (REACT_APP_idleTime), which applies cleanly and is read by nothing.
    expect(unknownKeys({ IDLE_TIME: 1, REACT_APP_idleTime: 2 }, new Set(["IDLE_TIME"]))).toEqual([
      "REACT_APP_idleTime",
    ]);
  });

  it("is empty when everything is declared", () => {
    expect(unknownKeys({ A: 1 }, new Set(["A", "B"]))).toEqual([]);
  });
});
