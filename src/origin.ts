/**
 * Trailing-slash normalisation for a service-gateway origin.
 *
 * ── WHY ONLY THIS, AND NOT THE WHOLE deriveServiceUrls() ─────────────────────
 *
 * Every consumer of this package composes its service URLs from one origin, and
 * every consumer composes DIFFERENT ONES. template-starterkit-nextjs derives
 * `/oauth-service`, `/next-service`, `/landing-user-service`;
 * nextv3-ai-interview-react derives `/oauth-service`, `/next-service`,
 * `/ai-interview-user-service` and a `LANDING_DOMAIN_URL` that is not a service
 * at all — and has no `/landing-user-service`. The path map is deployment data,
 * not mechanism, so it stays in each app's own src/config/derive.js.
 *
 * What genuinely repeats is this one line, and it repeats because getting it
 * wrong is invisible: `https://host/` + `/oauth-service` is a double slash,
 * which most gateways answer and some rewrite.
 *
 * Keeping derive.js in the app has a second, load-bearing effect: the host's
 * scripts/check-env-config.mjs resolves the `...deriveServiceUrls(x)` spread by
 * AST-parsing that file for a returned object LITERAL imported from "./derive".
 * Move the function into a package and the gate can no longer name the keys —
 * which is exactly the visibility whose absence shipped
 * `window.location.replace("undefined/oauth/authorize?…")` to production.
 *
 * ── THE THREE CASES, AND WHY THE EMPTY STRING IS NOT THE FALLBACK ────────────
 *
 *   normalizeOrigin(undefined, fb) -> fb    // env var not set at all
 *   normalizeOrigin("", fb)        -> ""    // env var set to empty ON PURPOSE
 *   normalizeOrigin("https://h/")  -> "https://h"
 *
 * The middle case is the one that matters and the one a naive `value || fallback`
 * gets wrong. `NEXT_PUBLIC_SERVICE_URL=` in a .env file means "serve me
 * root-relative URLs", which is how a static export gets served from a second
 * domain without hard-targeting the first. Collapsing it into the fallback would
 * silently re-target every API call at the build's default host.
 *
 * This mirrors a JavaScript default parameter (`function f(x = FALLBACK)`),
 * which also applies only to `undefined` — the shape the callers had before this
 * function existed. `null` is folded in with `undefined` rather than becoming the
 * string "null", which is what `String(null)` produced in the code this replaces.
 */
export function normalizeOrigin(value?: string | null, fallback = ""): string {
  const raw = value === undefined || value === null ? fallback : String(value);
  return raw.replace(/\/+$/, "");
}

/** The two fields of `Location` the resolver reads. Narrow so a test can pass a literal. */
export type ServiceOriginLocation = Pick<Location, "hostname" | "origin">;

/**
 * Is this page being served from the developer's own machine?
 *
 * `localhost`, the two loopback literals, and any `*.localhost` name (RFC 6761
 * reserves the whole TLD for loopback, and browsers resolve it without a hosts
 * entry). Nothing else: a LAN address such as `192.168.1.20` is deliberately a
 * deployment here, because the only thing that distinguishes "my phone hitting
 * my laptop" from "a host behind a private load balancer" is intent, and the
 * second one being wrong is an outage.
 *
 * `[::1]` is spelled with its brackets because that is what `location.hostname`
 * returns for an IPv6 literal.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * The service-gateway origin for THIS page load, decided in the browser.
 *
 * ── WHY THE CONFIGURED VALUE IS NOT ENOUGH ───────────────────────────────────
 *
 * `process.env.NEXT_PUBLIC_SERVICE_URL` is inlined by the compiler, so whatever
 * host it names is fixed on the build machine. A static export is then one
 * artefact served from several hostnames, each fronting its own gateway on the
 * same origin — and every one of them talks to the host the build named. This
 * shipped: a build carrying `https://nextv3.thinktalent.info`, served from
 * `323.thinktalent.info`, sent every API call and every task link to nextv3.
 * Nothing failed. The page loaded, the data was real, and it was another
 * environment's data.
 *
 * So on a deployment the origin is the one that served the page, and the
 * configured value is not consulted at all.
 *
 * ── THE ONE EXCEPTION ────────────────────────────────────────────────────────
 *
 * A dev server on localhost has no gateway behind it. There, and only there,
 * the configured value (normalised exactly as `normalizeOrigin` does, empty
 * string included) is the answer. See `isLoopbackHostname` for what counts.
 *
 * ── THE FOUR CASES ───────────────────────────────────────────────────────────
 *
 *   deployed host            -> location.origin
 *   loopback host            -> normalizeOrigin(value, fallback)
 *   no location at all       -> ""
 *   opaque origin ("null")   -> normalizeOrigin(value, fallback)
 *
 * No location is a build-time prerender or an SSR pass. It returns the empty
 * string — root-relative URLs — and NOT the configured value, because anything
 * computed there can end up in emitted HTML, and a root-relative URL is right on
 * every host the artefact is later served from while a named host is right on
 * one. The module that calls this is evaluated again in the browser, where the
 * real answer replaces it before the first request.
 *
 * An opaque origin (`file://`, a sandboxed iframe, `about:blank`) serialises as
 * the string "null". Composing `null/oauth-service` from it is the same class of
 * bug as `undefined/oauth/authorize`, so it falls back to the configured value.
 *
 * ── CALL IT AT MODULE SCOPE OF YOUR CONFIG, NOWHERE LATER ────────────────────
 *
 * It has to have run before the first request leaves, which rules out an effect.
 * Reading `location` at module scope is safe here for the two reasons it usually
 * is not: the read is guarded, so the prerender does not crash, and the result
 * is computed by the client bundle rather than serialised into it.
 *
 * `location` is a parameter only so a test can supply one. Passing `undefined`
 * selects the default, as with any default parameter; pass `null` to say "there
 * is no location".
 */
export function resolveServiceOrigin(
  value?: string | null,
  fallback = "",
  location: ServiceOriginLocation | null | undefined = globalThis.location,
): string {
  const configured = normalizeOrigin(value, fallback);
  if (!location) return "";
  if (isLoopbackHostname(location.hostname)) return configured;
  return /^https?:\/\//.test(location.origin) ? normalizeOrigin(location.origin) : configured;
}
