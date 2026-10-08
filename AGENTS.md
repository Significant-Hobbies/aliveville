## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`. Treat this repository as owned product code: protect production stability, keep changes scoped, verify work, and record durable follow-up tasks when something remains incomplete or blocked.

## Purpose

**AliveVille** is a browser-playable AI world simulator at aliveville.com/game. The active client is the 3D browser game (`web3d/`). The simulation server, world ingest, autonomous agent loop, quests, saves, and LLM routing live in `src/`. The Cloudflare Worker edge deploy (`worker/`) hosts one `GameSessionDO` per visitor session. The Astro marketing site (`astro-landing/`) is live — do not modify.

**Naming**: local checkout `ai-game`; GitHub repo `sarthakagrawal927/aliveville`; public product name AliveVille.

## Essential commands

```bash
pnpm install
pnpm dev:server        # sim server → http://localhost:5174
pnpm dev               # 3D Vite client → http://localhost:5175/game/
pnpm verify:readiness  # typecheck + lint + test + build:3d (the gate)
pnpm test              # Vitest (63 files)
pnpm playtest:game     # headless Playwright 3D smoke + screenshots
pnpm probe:lifelikeness # lifelikeness regression CLI
node scripts/check-docs.mjs  # validate docs (links, frontmatter, structure)
```

Deploy (manual): `pnpm build:3d && npx wrangler deploy`. See `docs/operations/deploy.md`.

## Critical constraints

- **The LLM never directly mutates the world.** Every LLM response is parsed as structured JSON, engine-validated, and rejected if invalid. See `docs/architecture/decisions/adr-008-engine-validated-json-actions.md`.
- **One DO per visitor session.** No cross-player state bleed. See `docs/architecture/decisions/adr-004-durable-objects-per-session.md`.
- **Same-account Worker→Worker fetches go through a service binding.** The `GATEWAY` binding in `wrangler.jsonc` is required; `workers.dev` cross-worker calls hang. See `docs/architecture/decisions/adr-010-cloudflare-workers-assets.md`.
- **`astro-landing/` is live marketing — do not modify.**
- **NPC/player positions are imperative, not React state.** Driving positions through the React `position` prop triggers R3F reconciliation every frame. See `docs/architecture/web3d-client.md`.
- **DO persist is debounced (5 s).** Writing world JSON on every 4 s tick saturates the DO SQLite write budget.
- **No user login; session UUID isolates worlds.** `ADMIN_TOKEN` gates `/api/restore`.
- **Production deploys are manual.** `main` stays releasable and green; CI is not an auto-deploy trigger.

## Documentation navigation

- **Short current view**: `STATUS.md`
- **Deep timeline + feature log**: `PROJECT_STATUS.md`
- **Docs index**: `docs/index.md` — the canonical knowledge system (product, architecture, decisions, development, operations, knowledge, current, archive).
- **Working on docs**: `docs/development/docs.md` — tree, rules, and validation.

## Documentation maintenance

1. **Markdown under `docs/` is the source of truth.** The repository validator checks frontmatter, links, and structure.
2. **One canonical home per fact.** Don't re-explain something that already has a doc — link to it.
3. **Don't duplicate code-discoverable facts.** Link to the file or command instead.
4. **Every `docs/**/*.md` (except `archive/`) needs a `title` in frontmatter.** Validate with `node scripts/check-docs.mjs` (CI runs this via `.github/workflows/docs.yml`).
5. **Prefer `docs/archive/<name>.md` over deletion** so git rename history survives.
6. **Keep pages 150–300 lines.** Split catch-all pages into focused topics.
7. **Mark unresolved questions explicitly** — do not invent information.

## Visual verification (see your own 3D changes)

This is a visual product — you cannot judge layout, models, lighting, or "feel"
from code alone. Use the headless screenshot harness to eyeball changes:

```bash
pnpm dev:server     # sim API on :5174  (one terminal / backgrounded)
pnpm dev            # vite client on :5175
pnpm playtest:game  # writes tmp/playtest-artifacts/game/{01-spawn,02-walked,03-orbit}.png
```

Then open/Read the PNGs. The harness (`tests/playtests/game-shots.ts`) loads the
game, clicks through start → character → play, suppresses the onboarding modal,
walks the player, and snaps a few frames. It prints a clear error if the servers
aren't running.

Caveats: headless WebGL is software-rendered (SwiftShader), so FPS and exact
shading differ from a real GPU, and WebGPU features (in-browser LLM, Kokoro)
don't run — but geometry, character models, placement, and composition all
render, which is enough to catch most layout/look regressions. The landing site
has a sibling harness: `pnpm playtest:astro-landing`. Full details:
`docs/development/visual-verification.md`.
