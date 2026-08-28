import { afterEach, describe, expect, it } from "vitest";
import {
  clearConfigSource,
  DEFAULT_CONFIG_KEYS,
  getConfig,
  hasConfigSource,
  requiredConfigKeys,
  resolvedOptions,
  setConfigSource,
} from "./config-source.js";

afterEach(() => {
  clearConfigSource();
});

describe("the registry", () => {
  it("throws a NAMED error when nothing has been wired", () => {
    // The alternative failure is silence: an undefined secret makes secure-ls
    // fail every decrypt, so the app looks to every user exactly as though they
    // were signed out. No error, no log, a green build.
    expect(hasConfigSource()).toBe(false);
    expect(() => getConfig()).toThrow(/no config source is set/);
    expect(() => getConfig()).toThrow(/setConfigSource\(config\)/);
  });

  it("holds the OBJECT, so a later mutation is visible - the env.json overlay contract", () => {
    const config: Record<string, unknown> = { STORAGE_SECRET: "before" };
    setConfigSource(config);

    // This is what src/utils/runtime-config.js does in the browser after
    // fetching the deployed env.json.
    Object.assign(config, { STORAGE_SECRET: "after", NEW_KEY: 1 });

    expect(getConfig()["STORAGE_SECRET"]).toBe("after");
    expect(getConfig()["NEW_KEY"]).toBe(1);
    expect(getConfig()).toBe(config); // identity, not a copy
  });

  it("rejects anything that is not an object, because a snapshot defeats the point", () => {
    // @ts-expect-error deliberate misuse
    expect(() => setConfigSource("STORAGE_SECRET=x")).toThrow(/config OBJECT/);
    // @ts-expect-error deliberate misuse
    expect(() => setConfigSource(null)).toThrow(/received null/);
  });

  it("defaults the key names to the two consumers' shared spelling", () => {
    setConfigSource({});
    expect(requiredConfigKeys()).toEqual(["STORAGE_SECRET", "OAUTH_SERVICE_URL", "RESPONSE_DECOMPRESS"]);
    expect(DEFAULT_CONFIG_KEYS.storageSecret).toBe("STORAGE_SECRET");
  });

  it("remaps only the keys it is given, and reports the RESOLVED names", () => {
    setConfigSource({}, { keys: { storageSecret: "LS_SECRET" } });
    expect(requiredConfigKeys()).toEqual(["LS_SECRET", "OAUTH_SERVICE_URL", "RESPONSE_DECOMPRESS"]);
  });

  it("defaults decompressOverrideKey to the RESOLVED responseDecompress name", () => {
    setConfigSource({}, { keys: { responseDecompress: "RD" } });
    expect(resolvedOptions().decompressOverrideKey).toBe("RD");

    // ...and an explicit override still wins. ai-interview passes
    // "VITE_RESPONSE_DECOMPRESS", a leftover from its Vite build.
    setConfigSource({}, { decompressOverrideKey: "VITE_RESPONSE_DECOMPRESS" });
    expect(resolvedOptions().decompressOverrideKey).toBe("VITE_RESPONSE_DECOMPRESS");
  });

  it("defaults mirrorRaw to false - a plaintext copy is opt-in, never inherited", () => {
    setConfigSource({});
    expect(resolvedOptions().mirrorRaw).toBe(false);
    setConfigSource({}, { mirrorRaw: true });
    expect(resolvedOptions().mirrorRaw).toBe(true);
  });

  it("resets every option on re-wire, so one call fully describes the state", () => {
    setConfigSource({}, { mirrorRaw: true, keys: { storageSecret: "LS_SECRET" } });
    setConfigSource({});
    expect(resolvedOptions().mirrorRaw).toBe(false);
    expect(requiredConfigKeys()[0]).toBe("STORAGE_SECRET");
  });

  it("lives on a globalThis registered symbol, defeating the dual-package hazard", () => {
    // If this package is resolved twice (ESM in the bundle, CJS in a build
    // script) module-level state would give TWO registries: the host wires one,
    // the code that matters reads the other, and getConfig() throws in
    // production while the build stays green. Symbol.for is cross-instance.
    const config = { STORAGE_SECRET: "x" };
    setConfigSource(config);
    const store = globalThis as unknown as Record<symbol, { config: unknown } | undefined>;
    const reg = store[Symbol.for("@devopsnext/starterkit-config-util/registry")];
    expect(reg?.config).toBe(config);
  });
});

describe("option validation", () => {
  it("REJECTS an unknown top-level option instead of ignoring it", () => {
    // A typo'd `mirrorRaw` silently reverts to the default: a plaintext copy
    // that stops (or starts) being written with nothing to say so. That is the
    // class of silent misconfiguration this package exists to stop, so it must
    // not be reproduced by the package's own wiring call.
    // @ts-expect-error deliberate typo
    expect(() => setConfigSource({}, { mirroRaw: true })).toThrow(/unknown option\(s\) mirroRaw/);
  });

  it("catches the flat-vs-nested signature mistake by name", () => {
    // setConfigSource(config, { storageSecret }) instead of
    // setConfigSource(config, { keys: { storageSecret } }) is the easy slip, and
    // silently ignoring it would leave the package reading STORAGE_SECRET while
    // the app defines LS_SECRET.
    // @ts-expect-error deliberate misuse
    expect(() => setConfigSource({}, { storageSecret: "LS_SECRET" })).toThrow(
      /unknown option\(s\) storageSecret/,
    );
  });

  it("rejects an unknown entry inside keys, and says what the right shape is", () => {
    // @ts-expect-error deliberate typo
    expect(() => setConfigSource({}, { keys: { storagSecret: "X" } })).toThrow(
      /unknown entry\(ies\) in `keys`: storagSecret/,
    );
  });

  it("accepts every documented option", () => {
    expect(() =>
      setConfigSource(
        {},
        {
          keys: { storageSecret: "A", oauthServiceUrl: "B", responseDecompress: "C" },
          mirrorRaw: true,
          decompressOverrideKey: "D",
          onUnauthorized: () => {},
          payloadOnlyDecompress: false,
        },
      ),
    ).not.toThrow();
    expect(resolvedOptions().payloadOnlyDecompress).toBe(false);
  });

  it("defaults payloadOnlyDecompress to true - this repo's shape", () => {
    setConfigSource({});
    expect(resolvedOptions().payloadOnlyDecompress).toBe(true);
  });
});
