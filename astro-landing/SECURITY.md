# Landing dependency security

Reviewed 2026-10-07 for issue #40. The landing has an independent pnpm 10.33.2
lockfile; the game dependency graph is separate. CI and the manual Pages release
run a frozen install, `node scripts/check-security.mjs`, and the static build.

Astro 7.3.6 fixes the critical AVIF advisory; source-map-js 1.2.2 fixes its
indexed-source-map advisory. One raw high advisory remains:
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp), in
http-cache-semantics 4.2.0 through Astro. Upstream lists no patched version.

Astro imports this package in `dist/assets/build/remote.js`; it cannot be removed.
That module constructs outbound image requests and uses CachePolicy's
`storable()` and `timeToLive()`. It does not evaluate an incoming visitor's
`max-stale` directive, which is required for the reported cross-user disclosure.
This landing uses native images and local public assets, builds static HTML, has
no Astro runtime adapter or image endpoint, and does not run Astro in production.
The separately authored Pages Functions do not import Astro or this package.
The advisory's shared authenticated response-cache prerequisites are absent.

The security check prints the unfiltered audit, with no pnpm audit exclusions.
It accepts only this exact advisory, installed version and sole dependency path,
while checking the reviewed static/no-image-optimizer boundary. All other
advisories, registry/command errors, added consumers, Astro version changes,
runtime adapters and image-optimization changes fail the gate. If an upstream
patch is reported, apply it and remove this disposition. Re-review on any change
to the stated boundary; this is not a claim that the dependency is patched.
