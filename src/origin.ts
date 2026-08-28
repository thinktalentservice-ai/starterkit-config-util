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
