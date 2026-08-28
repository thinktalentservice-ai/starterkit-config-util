// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * PRERENDER SAFETY, ASSERTED RATHER THAN ASSUMED.
 *
 * `new SecureLS(...)` touches localStorage in its constructor. At module scope
 * that runs during a static-export prerender - on the build machine, in Node,
 * where there is no localStorage - and it took `next build` down in one of the
 * consuming apps. This module is reached transitively from every controller, so
 * "any prerendered route that imports a controller" is the whole data layer.
 *
 * The consuming app's own build does NOT catch this: nothing under its route
 * tree imports a controller today, so the module never reaches the prerenderer.
 * By the time one does, the failure surfaces as a build error in an unrelated
 * page. This file closes that window here, where the code actually lives.
 *
 * `@vitest-environment node` is the entire point of the file - the default jsdom
 * environment supplies a window and would pass whether the guard existed or not.
 */
describe("the storage entry under prerender (no window)", () => {
  it("has no window, which is what makes the rest of this file meaningful", () => {
    expect(typeof window).toBe("undefined");
  });

  it("imports without constructing SecureLS or touching localStorage", async () => {
    await expect(import("./storage.js")).resolves.toBeDefined();
  });

  it("imports the fetch entry too, which pulls storage transitively", async () => {
    await expect(import("./fetch.js")).resolves.toBeDefined();
  });

  it("does not throw at import time when NO config source has been wired", async () => {
    // The module-scope default instance must do no work until an accessor is
    // called. A module-scope read would make merely importing this package fail
    // the prerender of every route.
    const mod = await import("./storage.js");
    expect(mod.default).toBeDefined();
  });

  it("reads on the server as null instead of throwing", async () => {
    const { createApiUtils } = await import("./storage.js");
    const { setConfigSource, clearConfigSource } = await import("./config-source.js");
    setConfigSource({ STORAGE_SECRET: "server-side-secret" });
    try {
      const api = createApiUtils();
      expect(api.getCookie("accessToken")).toBeNull();
      // The setters no-op rather than throw: a client component's module body
      // still evaluates on the server, and a write from one must not fail the
      // prerender.
      expect(() => api.setCookie("accessToken", "x")).not.toThrow();
      expect(() => api.setLocalStorage("userInfo", { a: 1 })).not.toThrow();
    } finally {
      clearConfigSource();
    }
  });
});
