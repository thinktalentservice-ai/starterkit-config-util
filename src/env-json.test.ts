import { describe, expect, it } from "vitest";
import { CryptoEncryption } from "@devopsthink/react-security-util";
import {
  ENV_JSON_KEY_PREFIX,
  decodeEnvJson,
  describeEnvJsonKeyChanges,
  normalizeEnvJsonKeys,
  unknownKeys,
} from "./env-json.js";

const encode = (obj: unknown): string =>
  JSON.stringify({ configEnv: CryptoEncryption.encrypt(JSON.stringify(obj)) });

describe("decodeEnvJson", () => {
  it("decrypts configEnv and returns the keys VERBATIM", () => {
    // The contract in one assertion: whoever writes env.json writes the key the
    // code reads. No camelCase transform, no lookup table - both of which fail
    // in the direction nobody notices, by landing the value under a name nothing
    // reads while looking like they worked.
    const { overrides, keys, renamed, collisions } = decodeEnvJson(
      encode({ INTEGRATION_ALLOWED_DOMAINS: "a.example", IDLE_TIME: 3600 }),
    );
    expect(overrides).toEqual({ INTEGRATION_ALLOWED_DOMAINS: "a.example", IDLE_TIME: 3600 });
    expect(keys).toEqual(["INTEGRATION_ALLOWED_DOMAINS", "IDLE_TIME"]);
    // A payload already written in config keys is untouched, which is what makes
    // the strip safe to apply unconditionally: DevOps can fix the dialect later
    // with no matching code change in any consumer.
    expect(renamed).toEqual([]);
    expect(collisions).toEqual([]);
  });

  it("strips the ONE NEXT_PUBLIC_ prefix, because env.json is not process.env", () => {
    // The DevOps pipeline writes the payload in `.env` dialect. Left alone those
    // keys land on the config object under names nothing reads - applied, green,
    // silently ignored. See the header of env-json.ts.
    const { overrides, keys, sourceKeys, renamed } = decodeEnvJson(
      encode({ NEXT_PUBLIC_IDLE_TIME: 3600, NEXT_PUBLIC_INTEGRATION_ALLOWED_DOMAINS: "a.example" }),
    );
    expect(overrides).toEqual({ IDLE_TIME: 3600, INTEGRATION_ALLOWED_DOMAINS: "a.example" });
    expect(keys).toEqual(["IDLE_TIME", "INTEGRATION_ALLOWED_DOMAINS"]);
    // What the file literally spelled stays answerable without decrypting again.
    expect(sourceKeys).toEqual([
      "NEXT_PUBLIC_IDLE_TIME",
      "NEXT_PUBLIC_INTEGRATION_ALLOWED_DOMAINS",
    ]);
    expect(renamed).toEqual([
      { from: "NEXT_PUBLIC_IDLE_TIME", to: "IDLE_TIME" },
      { from: "NEXT_PUBLIC_INTEGRATION_ALLOWED_DOMAINS", to: "INTEGRATION_ALLOWED_DOMAINS" },
    ]);
  });

  it("strips on the plaintext envVariables path too", () => {
    // Same file, two deployment shapes. A strip reaching only one of them would
    // make the docker and static variants disagree about what the payload means.
    const { overrides } = decodeEnvJson(
      JSON.stringify({ envVariables: { NEXT_PUBLIC_IDLE_TIME: 60 } }),
    );
    expect(overrides).toEqual({ IDLE_TIME: 60 });
  });

  it("never strips a bare prefix, which is not a key", () => {
    const { overrides } = decodeEnvJson(encode({ [ENV_JSON_KEY_PREFIX]: "x" }));
    expect(overrides).toEqual({ NEXT_PUBLIC_: "x" });
  });

  it.each([
    ["prefixed first", ["NEXT_PUBLIC_IDLE_TIME", "IDLE_TIME"]],
    ["literal first", ["IDLE_TIME", "NEXT_PUBLIC_IDLE_TIME"]],
  ])(
    "resolves a both-spellings collision to the LITERAL key — %s",
    (_label, order) => {
      // Last-write-wins would make the effective config depend on JSON key
      // order: invisible in a diff, unstable across whatever wrote the file.
      const values: Record<string, unknown> = {};
      for (const k of order) values[k] = k === "IDLE_TIME" ? 7777 : 4242;

      const { overrides, keys, collisions } = decodeEnvJson(encode(values));
      expect(overrides).toEqual({ IDLE_TIME: 7777 });
      expect(keys).toEqual(["IDLE_TIME"]);
      expect(collisions).toEqual([
        { key: "IDLE_TIME", kept: "IDLE_TIME", dropped: "NEXT_PUBLIC_IDLE_TIME" },
      ]);
    },
  );

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

describe("normalizeEnvJsonKeys", () => {
  it("is exported so a consumer decoding by another route applies the SAME rule", () => {
    // Two implementations of one rule is the drift this package exists to
    // remove; a consumer with a plaintext endpoint or a test fixture must not
    // have to re-derive the strip.
    const out = normalizeEnvJsonKeys({
      overrides: { NEXT_PUBLIC_A: 1, B: 2 },
      keys: ["NEXT_PUBLIC_A", "B"],
    });
    expect(out.overrides).toEqual({ A: 1, B: 2 });
    expect(out.keys).toEqual(["A", "B"]);
  });

  it("preserves file order, including for a key that was renamed", () => {
    const out = normalizeEnvJsonKeys({
      overrides: { Z: 1, NEXT_PUBLIC_A: 2 },
      keys: ["Z", "NEXT_PUBLIC_A"],
    });
    expect(out.keys).toEqual(["Z", "A"]);
  });

  it("keeps null on a renamed key, since null is a value an operator can mean", () => {
    const out = normalizeEnvJsonKeys({
      overrides: { NEXT_PUBLIC_A: null },
      keys: ["NEXT_PUBLIC_A"],
    });
    expect(out.overrides).toEqual({ A: null });
  });
});

describe("describeEnvJsonKeyChanges", () => {
  // The strip is SAID OUT LOUD rather than done quietly: a normaliser nobody can
  // see in a log is indistinguishable from a payload that never needed one, and
  // those two states want opposite follow-up actions.
  it("says nothing when the payload was already written in config keys", () => {
    expect(describeEnvJsonKeyChanges({ renamed: [], collisions: [] })).toEqual([]);
  });

  it("names every rename and every collision", () => {
    const lines = describeEnvJsonKeyChanges(
      normalizeEnvJsonKeys({
        overrides: { NEXT_PUBLIC_IDLE_TIME: 4242, IDLE_TIME: 7777, NEXT_PUBLIC_B: 1 },
        keys: ["NEXT_PUBLIC_IDLE_TIME", "IDLE_TIME", "NEXT_PUBLIC_B"],
      }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('kept "IDLE_TIME"');
    expect(lines[0]).toContain('"NEXT_PUBLIC_IDLE_TIME"');
    expect(lines[1]).toContain("stripped NEXT_PUBLIC_ from 2 key(s)");
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
