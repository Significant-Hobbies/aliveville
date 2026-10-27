# Landing dependency security

Updated 2026-10-27. The landing retains its independent pnpm 10.33.2 lockfile;
the game dependency graph is unchanged. CI and manual Pages releases run a
frozen install, the unfiltered audit gate, cache regression tests, and the static build.

The former http-cache-semantics 4.2.0 reachability exception is retired.
Version 4.3.0 uses the same explicit max-stale security patch and regression
matrix as other Fleet consumers: no-store, no-cache, private, shared cookies,
proxy-revalidate, must-revalidate, serialization and ordinary cache behavior.
Zod 4.6.6 and Undici 8.12.2 resolve the other reported landing advisories.

The gate accepts no advisory or muted finding. Registry failures, inconsistent
counts and unexplained command failures fail closed. Existing static Astro,
no-image-optimizer and independent Pages Functions boundaries remain enforced.
