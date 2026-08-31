# Integrations

`@devopsnext/starterkit-config-util/integrations` — the `javascript_integration` table, applied.

A DevOps pipeline dumps a MySQL table to a static JSON array, one row per third-party snippet.
Every frontend in this family then does the same four things with it: filter on `STATUS` and
`ALLOWED_DOMAIN`, sort on `INTEGRATION_ORDER`, re-create each `<script>` node, and run them in
order. That rule was written **eight times** before this entry existed.

> **This entry executes database-authored JavaScript.** Whoever can write a row in the table can
> run script on every page of every app that calls `loadIntegrations`. Never feed it anything an
> end user can set, and never serve the JSON from an origin a third party can write.
>
> `INTEGRATION_TEXT` is also secret-bearing in practice — real rows embed an AES key as a string
> literal. Nothing in this module logs, echoes or returns it, and neither should your code.

Zero peers. The pure half runs anywhere; only `loadIntegrations` needs a DOM.

---

## Browser

```jsx
"use client";
import { useEffect } from "react";
import { loadIntegrations } from "@devopsnext/starterkit-config-util/integrations";
import config from "@/config";

const ONCE = "data-integrations-loaded";

export default function IntegrationBoot() {
  useEffect(() => {
    if (!config.INTEGRATIONS_ENABLED) return;
    // Set BEFORE the await: loadIntegrations is async, so a guard that awaited
    // first would let two StrictMode effects both pass.
    if (document.documentElement.hasAttribute(ONCE)) return;
    document.documentElement.setAttribute(ONCE, "");

    loadIntegrations({
      sourceUrl: `${config.BASE_PATH || ""}/javascript_integration.json`,
      allowedDomains: config.INTEGRATION_ALLOWED_DOMAINS || "",
    })
      .then((r) => console.debug(`[integration] ${r.executed} script(s)`, r))
      .catch((e) => console.error("[integration] loader failed", e));
  }, []);

  return null;
}
```

**The `.catch()` is mandatory.** This function *rejects* on a missing file, an HTTP error,
unparseable JSON or a non-array payload — where the hand-written loaders it replaces swallowed all
four into a `console.error`. Same reasoning as `decodeEnvJson`: the library reports, the caller
decides. Without a catch you get an unhandled rejection instead of a logged one.

**Run it once per document, and own that guard yourself.** It is policy, not mechanism — this
package has no React and no `"use client"` banner. A DOM-anchored guard (an attribute on `<html>`)
rather than a module-scope flag, because Fast Refresh re-evaluates the module in dev.

**If the allow-list arrives from a deployed `env.json`, await that overlay first.** The value is
read synchronously when you call, so calling before the overlay applies uses the build-time
allow-list every time and the deployed one never — while looking, in devtools, exactly like a call
that worked.

## Server (the Express interceptor half)

`selectIntegrations` is pure — no DOM, no fetch, no clock. It is the entire rule the cheerio
interceptors in `docker/server.js` implement by hand:

```js
import { selectIntegrations } from "@devopsnext/starterkit-config-util/integrations";
import table from "./javascript_integration.json" with { type: "json" };

const $ = cheerio.load(body);
for (const row of selectIntegrations(table, {
  host: req.headers.host,
  allowedDomains: process.env.REACT_APP_allowedDomains ?? "",
})) {
  $("head").append(row.INTEGRATION_TEXT);
}
```

---

## The selection rule

| `ALLOWED_DOMAIN` | Result |
|---|---|
| `"N"` | loads on every host |
| `"Y"` | loads only when `host` is in the allow-list |
| anything else — `"y"`, `""`, `null`, a value added next year | **excluded** |

Plus `STATUS === "Y"` and a non-empty `INTEGRATION_TEXT`. Then sorted ascending on
`INTEGRATION_ORDER`, with every falsy value sorting as `0`.

**It fails closed.** A `default: allow` would ship every future value of that column to every host,
which is the direction nobody notices — the symptom is a widget appearing where it should not.

**The host match is exact and includes the port.** `location.host` is `hostname[:port]`, so
`a.example` does not match `a.example:3000`. This is why domain-gated rows are dormant under a local
dev server and only come alive on the deployed host.

**Any `%` voids the whole allow-list.** The Vite apps write `%VITE_allowedDomains%` into
`index.html` and rely on a build-time substitution; when it does not happen the raw placeholder
arrives here. An empty list means a domain-gated widget loads *nowhere*, which is the safe direction.

**Ordering is sequential and awaited, and that is not decorative.** The row that loads secure-ls is
a different row from the one that calls `new SecureLS`. Run them concurrently and they fail
intermittently, which is worse than failing.

---

## CSP origins

A `<script>` this loader injects is subject to your `script-src`. A policy that does not name the
third-party origins blocks every one of them — at HTTP 200, with the inline rows still running and
then throwing `ReferenceError` on globals the blocked scripts were meant to define.

```js
import { extractIntegrationOrigins, extractIntegrationUrlHints }
  from "@devopsnext/starterkit-config-util/integrations";

extractIntegrationOrigins(table);   // ["https://cdn.jsdelivr.net", …]  -> fail a gate on these
extractIntegrationUrlHints(table);  // ["https://app.productfruits.com"] -> warn only
```

Both scan **every** record, ignoring `STATUS` and `ALLOWED_DOMAIN` — deliberately asymmetric with
`selectIntegrations`. A CSP is one static header serving every host and every future flip of that
column; a scan limited to today's active rows goes green, and then a DBA re-enables a row and blocks
it in production with no code change to point at.

**`extractIntegrationOrigins` is authoritative and incomplete, and the two are not in tension.** It
reads the `src` *attribute* of a `<script>` tag. It cannot see a `src` assigned by an inline script
(`r.src = "https://…"`), which is how a live production row loads its widget today; nor `import()`,
`fetch()`, `new Worker()`, a preload link, or anything a loaded third party then loads for itself.

`extractIntegrationUrlHints` exists for exactly that gap and is **advisory only — never fail a build
on it.** It reports every http(s) origin appearing anywhere in the text, minus what the attribute
scan already found, so an API endpoint and a real script host look identical to it. Without it a CSP
gate is green on the one integration that is actually broken.

A regex is the only parser available: a gate runs in plain Node, `jsdom` is a devDependency that is
never shipped, and this package takes no runtime dependencies.

---

## Reading the result

```
{ sourceUrl, host, allowedDomains, selected, skipped, executed, failures, aborted }
```

`skipped` carries a reason per rejected record (`status-not-Y`, `domain-not-allowed`,
`unknown-allowed-domain`, `empty-text`, `not-an-object`). `failures` names the `INTEGRATION_ID` and
`src` of every external script that did not load — a CSP block lands there, alongside the browser's
own violation report.

This exists because "did anything run?" used to be unanswerable. An empty table, an allow-list that
excluded everything, and a CSP that blocked every external script are three different problems that
all looked identical: silent.

See also [[Troubleshooting]], [[Configuration]], [[API Reference]].
