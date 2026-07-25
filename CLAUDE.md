# CLAUDE.md

Orientation for Claude Code (and other AI assistants) working in this repository.

`AGENTS.md` is the shared human+AI contributor contract and stays authoritative where the
two overlap. This file is the codebase-structure and workflow guide: what lives where, how
layers connect, which commands to run, and which invariants must not break.

---

## 1. What Paperclip is

Paperclip is a **control plane for companies of AI agents**. One instance runs many
*companies*; each company has agents (employees), an org chart, goals, projects, issues
(tasks), budgets, approvals, and an audit log.

Two layers:

- **Control plane** (this repo) — registry, task assignment, execution locks, budgets,
  approvals, activity logging, heartbeat scheduling. It *orchestrates*; it does not run
  models itself.
- **Execution services (adapters)** — agents run elsewhere (Claude Code, Codex, Cursor,
  Gemini, OpenCode, Pi, gateways, external plugins) and phone home.

Everything is **company-scoped**. If a change adds a domain entity or endpoint that isn't
scoped to a company, that is almost certainly a bug.

### Read order for deeper context

1. `doc/GOAL.md` — mission
2. `doc/PRODUCT.md` — product model (company, agents, hierarchy, skills policy)
3. `doc/SPEC-implementation.md` — the concrete V1 build contract (data model, state
   machines, permission matrix, REST contract). This is the spec to conform to.
4. `doc/DEVELOPING.md` — dev environment, worktrees, catalogs, local instance layout
5. `doc/DATABASE.md` — the three DB modes
6. `doc/execution-semantics.md` — ownership, blockers, watchdogs, liveness
7. `DESIGN.md` + `doc/design/CHANGING-THE-UI.md` — UI design system rules

`doc/SPEC.md` is long-horizon product context, not the build contract.

---

## 2. Repo map

Monorepo: pnpm workspaces (`pnpm-workspace.yaml`), TypeScript ESM throughout, Node ≥ 20,
pnpm 9.15.4.

```
server/            Express 5 REST API + orchestration services (the control plane)
  src/routes/      One file per resource; each exports `xRoutes(db) => Router`
  src/services/    ~200 domain services; `xService(db)` factories + pure helpers
  src/middleware/  actor/auth, validate, error handler, logging, redaction, guards
  src/adapters/    server-side adapter registry wiring
  src/realtime/    SSE / live update plumbing
  src/storage/     local_disk + S3 storage providers
  src/secrets/     secret providers (local_encrypted, AWS, …)
  src/__tests__/   ~390 integration/route tests (see §7)

ui/                React 19 + Vite 6 + Tailwind v4 board UI
  src/pages/       ~126 route-level pages
  src/components/  Feature components; `components/ui/` holds shadcn-style primitives
  src/api/         Typed fetch clients, one module per resource, over `src/api/client.ts`
  src/hooks/       TanStack Query hooks
  src/context/     Company selection and other app-level context
  src/index.css    THE design token source (Tailwind v4 `@theme`; no tailwind.config)
  storybook/       Storybook config + ~69 stories (kept out of app source)

packages/
  db/              Drizzle schema (`src/schema/*.ts`, 108 tables), 191 SQL migrations,
                   embedded-Postgres bootstrap, backup, migration safety checks
  shared/          Cross-layer contract: `api.ts` (path constants), `types/`,
                   `validators/` (zod), `constants.ts`, `telemetry/`
  adapters/        One package per adapter: claude-local, codex-local, cursor-local,
                   cursor-cloud, gemini-local, grok-local, opencode-local, pi-local,
                   hermes, hermes-gateway, openclaw-gateway (+ AUTHORING.md)
  adapter-utils/   Shared adapter helpers (ssh round-trip, parsing, process control)
  plugins/         Plugin SDK, scaffolder, example + sandbox-provider plugins
  skills-catalog/  App-shipped company skills catalog + generated/catalog.json
  teams-catalog/   App-shipped agentcompanies/v1 team packages
  mcp-server/      Paperclip MCP server

cli/               `paperclipai` CLI (onboard, run, doctor, worktree, auth, routines…)
scripts/           Dev runner, test runner, release, codemods, CI gate checks
tests/             e2e/ (Playwright), release-smoke/, storybook-visual/
doc/               Internal specs and operational docs (see §1)
docs/              Public Mintlify docs site (`pnpm docs:dev`)
skills/            Paperclip runtime skills (NOT the shipped catalog)
.agents/, .claude/ Repo-local agent skills and subagent definitions
```

---

## 3. Dev setup and everyday commands

Leave `DATABASE_URL` unset — the server boots embedded PostgreSQL automatically.

```sh
pnpm install
pnpm dev            # watch mode; API + UI both on http://localhost:3100
pnpm dev:once       # no file watching; auto-applies pending migrations
pnpm dev:list       # inspect the managed dev runner for this repo
pnpm dev:stop
```

`pnpm dev` is idempotent per repo/instance — it reports an existing runner rather than
starting a duplicate. Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Runtime state lives under `~/.paperclip/instances/default/` (config, `db/`, `data/storage`,
`logs/`, `secrets/`, `workspaces/`, `projects/`). Override with `PAPERCLIP_HOME` and
`PAPERCLIP_INSTANCE_ID`. To reset local dev data, delete that instance's `db/` directory.

Other entry points:

```sh
pnpm storybook                  # UI Storybook on :6006
pnpm docs:dev                   # Mintlify docs site
pnpm paperclipai <command>      # the CLI (onboard, doctor, worktree, run, …)
pnpm dev --bind lan|tailnet     # authenticated/private dev modes
```

**Git worktrees:** never point two servers at the same embedded Postgres data dir. Use
`paperclipai worktree init` / `worktree:make` / `worktree repair` / `worktree reseed` —
these create repo-local `.paperclip/config.json` + `.env` and an isolated instance under
`~/.paperclip-worktrees/`. `pnpm dev` fails fast in a linked worktree without that env.

---

## 4. Architecture and layering

### Request path

```
ui/src/pages  →  ui/src/hooks (TanStack Query)  →  ui/src/api/<resource>.ts
      →  ui/src/api/client.ts (fetch, credentials: "include", ApiError)
      →  /api/*  →  server/src/app.ts  →  middleware (actor → validate → route)
      →  server/src/routes/<resource>.ts  →  server/src/services/<domain>.ts
      →  packages/db (Drizzle)  →  PostgreSQL
```

### The contract rule (most important structural rule)

A schema or API change is not done until **every** layer is updated together:

1. `packages/db/src/schema/*.ts` (+ export from `schema/index.ts`) + migration
2. `packages/shared` — `types/`, `validators/` (zod), `api.ts` path constants
3. `server/` — route + service + activity logging
4. `ui/` — `src/api/` client, hooks, pages

Leaving one layer behind is the single most common source of breakage here.

### Route conventions

Routes are factories returning an Express `Router`, mounted in `server/src/app.ts`:

```ts
export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);          // company boundary
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, { companyId, ...actor, action: "goal.created", entityType: "goal", entityId: goal.id });
    res.status(201).json(goal);
  });

  return router;
}
```

When adding an endpoint:

- Base path is `/api`; add the path to `packages/shared/src/api.ts` rather than hardcoding.
- Validate the body with a zod schema from `packages/shared/src/validators` via `validate()`.
- Enforce company access (`assertCompanyAccess` / `getAccessibleResource` in `routes/authz.ts`).
- Distinguish actor types: board access is full-control operator context; agent access uses
  bearer API keys (`agent_api_keys`, hashed at rest) and must never reach another company.
- Write an `activity_log` entry for every mutation.
- Return consistent errors: `400 / 401 / 403 / 404 / 409 / 422 / 500`.

### Code conventions

- **ESM with explicit `.js` extensions** on relative imports (`./services/index.js`), even
  in `.ts` files — `moduleResolution: NodeNext`. Getting this wrong breaks the build.
- `strict: true` everywhere (`tsconfig.base.json`); no implicit `any`.
- Services are `xService(db)` factories or pure functions; keep DB access out of routes.
- UI imports use the `@/` alias for `ui/src/*`.
- Workspace deps are `workspace:*`; don't add cross-package relative imports.
- Match the surrounding file's style — this codebase uses sparse comments reserved for
  non-obvious invariants, often with a ticket reference.

---

## 5. Database changes

```sh
# 1. edit packages/db/src/schema/<table>.ts
# 2. export it from packages/db/src/schema/index.ts
pnpm db:generate     # compiles packages/db, then generates the SQL migration
pnpm -r typecheck
pnpm db:migrate      # apply (dev:once also auto-applies pending migrations)
```

Notes:

- `packages/db/drizzle.config.ts` reads the **compiled** schema from `dist/schema/*.js`, so
  `db:generate` builds first. A missing export from `schema/index.ts` = a missing migration.
- Migrations are `NNNN_name.sql` under `packages/db/src/migrations` with a `meta/_journal.json`.
  Numbering must be unique and strictly ordered (`check-migration-numbering.ts`) — rebase
  collisions need renumbering, not a duplicate index.
- `check-migration-safety.ts` guards destructive operations; there are dedicated
  per-migration tests in `packages/db/src/*-migration.test.ts` for non-trivial changes.
- Commit the generated SQL with the schema change in the same commit.

---

## 6. Adapters and plugins

Each adapter is its own workspace package with `src/server`, `src/ui`, and `src/cli` entry
points. Built-ins are wired into `server/src/adapters/registry.ts` (and mirrored on the UI
side in `ui/src/adapters/`); external ones load through `server/src/adapters/plugin-loader.ts`.
`server/src/services/adapter-registry-bootstrap.ts` handles the declarative
`PAPERCLIP_ADAPTERS` availability/runtime config, not registration. Read
`packages/adapters/AUTHORING.md` before writing an adapter.

Hard invariants:

- **No-remote-git contract.** The local execution-workspace cwd is the only cross-run
  persistence boundary. Never `git push` from adapter or runtime code and never assume a
  git remote exists. For remote execution use `prepareWorkspaceForSshExecution` /
  `restoreWorkspaceFromSshExecution` from `@paperclipai/adapter-utils`. Enforced in CI by
  `scripts/check-no-git-push.mjs` (opt out per line with
  `// paperclip:allow-git-push: <reason>` only when an operator-configured path truly needs it).
- Adapter failures must surface as clear run-level errors; a missing local CLI must not
  crash the API server.
- External adapters load dynamically through the plugin flow — the plugin loader must have
  **zero** hardcoded adapter imports, and core `server/`/`ui/` must not import them.

Catalog packages (`packages/skills-catalog`, `packages/teams-catalog`) ship a checked-in
`generated/catalog.json`. After editing any catalog `SKILL.md`/`TEAM.md`, frontmatter,
category, or slug, regenerate in the same commit:

```sh
pnpm --filter @paperclipai/skills-catalog build:manifest
pnpm --filter @paperclipai/skills-catalog validate
```

CI fails if the regenerated manifest differs from the committed one.

---

## 7. Testing

Layout:

- `server/src/__tests__/` — route/integration tests. Tests needing a real Postgres **must**
  use `./helpers/embedded-postgres.ts`, never construct `embedded-postgres` directly (it
  otherwise risks the live control-plane database).
- Colocated `*.test.ts` next to the unit under test in `packages/`, `ui/src/`, `cli/`.
- `ui/src/**/*.test.tsx` — component tests (Vitest + jsdom, `ui/vitest.setup.ts`).
- `tests/e2e`, `tests/release-smoke`, `tests/storybook-visual` — Playwright, opt-in.

Commands:

```sh
pnpm test           # DEFAULT: Vitest only, via scripts/run-vitest-stable.mjs
pnpm test:watch     # interactive Vitest
pnpm -r typecheck
pnpm build

pnpm test:e2e                # Playwright e2e            } opt-in — run only when
pnpm test:release-smoke      # release smoke             } your change touches them
pnpm test:storybook-visual   # Storybook visual diffs    } or you're verifying CI
```

`run-vitest-stable.mjs` splits the suite into `general` and `serialized` modes (route/authz
and other DB-heavy server tests run serialized) and supports sharding — CI uses those flags;
locally plain `pnpm test` is right.

Working style: **run the smallest check that proves the change first.** Don't default to a
repo-wide typecheck/build/test on every step. Run the full set —
`pnpm -r typecheck && pnpm test:run && pnpm build` — before a PR-ready hand-off or when the
change is broad enough that narrow checks don't cover the risk. If something couldn't be
run, say so explicitly.

Storybook visual baselines are **Linux/ubuntu-24.04 only** and pixel-exact; local macOS or
Windows runs produce false diffs. Treat the `Storybook Visual` GitHub Actions workflow as
the source of truth. Never commit generated PNG snapshots.

---

## 8. UI conventions and the token rule

`DESIGN.md` is the source of truth for UI decisions; `doc/design/CHANGING-THE-UI.md` is the
day-to-day how-to. The rules that most often trip up changes:

- **Tokens are the only source of visual values.** Every color, spacing, radius, type size,
  shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the
  token layer in `ui/src/index.css`. No hex, no `rgb()/hsl()/oklch()` literals, no
  value-bearing arbitrary Tailwind brackets (`p-[13px]`), no raw `font-size` / `fontSize`
  declarations — outside the documented allowlist in `index.css`.
- **`ui/src/index.css` is the only token source.** Do not create `ui/src/tokens/`. Tailwind
  v4, no `tailwind.config`. `@theme inline` bakes literals at build time, so anything that
  must be runtime-tunable (theme editor, dark mode) belongs in a non-inline block.
- **One component per job.** Before creating a component, prove no existing one covers it;
  variants are props. `ui/src/components/ui/` holds the shared primitives.
- Status vocabulary (running / paused / blocked / awaiting-approval / over-budget) maps to
  one semantic token set used identically everywhere.
- Machine values (IDs, costs, token counts, timestamps, logs) use the monospace token and
  shared formatting helpers.
- Keep routes and nav aligned with the actual API surface, use company-selection context on
  company-scoped pages, and surface API failures — never swallow them.

Before committing UI changes:

```sh
pnpm check:token-gates    # scripts/check-token-gates.mjs — fails on any un-allowlisted violation
```

The `design-guide` skill (`.claude/skills/design-guide/`) covers component creation in depth.

---

## 9. Control-plane invariants (do not break)

1. **Company scoping** — every domain entity is company-scoped and the boundary is enforced
   in routes/services. Agent API keys must never reach another company.
2. **Single-assignee task model** — one assignee per issue.
3. **Atomic issue checkout** — checkout/execution locks are atomic; no double-claiming.
4. **Approval gates** — governed actions require an approval; `pending -> approved | rejected
   | cancelled`, terminal after decision.
5. **Budget hard stops** — budget breach auto-pauses; don't add paths that bypass it.
6. **Activity logging** — every mutating action writes to `activity_log`.
7. **Issue status transitions** (`doc/SPEC-implementation.md` §8.2):
   `backlog → todo|cancelled`, `todo → in_progress|blocked|cancelled`,
   `in_progress → in_review|blocked|done|cancelled`, `in_review → in_progress|done|cancelled`,
   `blocked → todo|in_progress|cancelled`; `done`/`cancelled` terminal. Side effects set
   `started_at` / `completed_at` / `cancelled_at`.
8. **Agent status transitions** (§8.1): `idle ↔ running`, `running → error`, `error → idle`,
   `* → paused` (running requires cancel flow), `* → terminated` (board only, irreversible).
9. **Non-terminal liveness** — an agent-owned `todo`/`in_progress`/`in_review`/`blocked`
   issue must have a live execution path, an explicit waiting path (persisted monitor,
   scheduled wake, first-class blocker with named owner, or healthy delegated child), or an
   explicit recovery action. Detached shell jobs, PIDs, logs, and comments are *evidence*,
   not liveness. See `doc/execution-semantics.md`.
10. **Config freshness** — agent/project/environment/secret/skill/workspace config is sampled
    at run boundaries; an in-flight heartbeat finishes on the config it started with.

---

## 10. Definition of done, and PR rules

A change is done when:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db / shared / server / ui
4. Docs are updated when behavior or commands change
5. The PR body follows `.github/PULL_REQUEST_TEMPLATE.md` with every section filled in

PR requirements (full detail in `CONTRIBUTING.md`):

- **Never commit `pnpm-lock.yaml` in a PR.** GitHub Actions owns the lockfile; the `policy`
  CI job fails PRs that touch it. CI regenerates it when manifests change.
- Use the PR template: Thinking Path, Linked Issues or Issue Description, What Changed,
  Verification, Risks, **Model Used** (provider + exact model ID + capabilities), Checklist.
- Reference **public** GitHub issues only. No internal instance references — no `PAP-123`
  style ids, no `/PAP/issues/...` or `agent://...` links, no localhost/tailnet URLs.
- Branch names describe the change (`fix/...`, `docs/...`), never an internal ticket id.
- Search for duplicate/in-flight PRs first; helping an existing PR beats opening a parallel one.
- Uncoordinated core feature PRs may be closed — check `ROADMAP.md` and discuss first.
  Extensions belong in the plugin system (`doc/plugins/PLUGIN_SPEC.md`).
- Telemetry changes must update `packages/shared/src/telemetry/README.md` in the same PR.
- Greptile review must reach 5/5 with no open P2s, recommendations, or follow-ups.

Repo hygiene:

- New plan documents go in `doc/plans/` as `YYYY-MM-DD-slug.md`. Don't wholesale replace
  strategic docs (`doc/SPEC.md`, `doc/SPEC-implementation.md`) — prefer additive updates.
- When a task produces an inspectable deliverable file, upload it as a Paperclip artifact
  (`skills/paperclip/scripts/paperclip-upload-artifact.sh`) rather than leaving a local path
  as the only access route. See `doc/AGENT-ARTIFACTS.md`.

---

## 11. CI gates worth knowing about

`.github/workflows/pr.yml` runs before anything else and fails fast on:

| Gate | Script |
|---|---|
| Manual lockfile edits | inline diff check against merge base |
| `git push` in adapter/runtime code | `scripts/check-no-git-push.mjs` |
| Dockerfile deps stage drift | `scripts/check-docker-deps-stage.mjs` |
| Release package manifest | `scripts/release-package-map.mjs check` |
| Release package bootstrap | `scripts/check-release-package-bootstrap.mjs` |
| Dependency resolution on manifest change | `pnpm install --lockfile-only` |

Then typecheck, sharded Vitest, build, and (label- or workflow-gated) e2e, release-smoke,
storybook-visual, and docker workflows.

---

## 12. Gotchas

- Relative imports need the `.js` extension. Yes, in TypeScript files.
- `pnpm db:generate` silently produces nothing useful if the new table isn't exported from
  `packages/db/src/schema/index.ts`.
- Two Paperclip servers must never share one embedded Postgres data dir — use worktree
  instances.
- Server tests that spin up Postgres must go through `server/src/__tests__/helpers/embedded-postgres.ts`.
- `packages/shared/src/api.ts` is the path registry; hardcoded `/api/...` strings in `ui/`
  drift silently.
- Storybook visual diffs on non-Linux hosts are almost always font rasterization, not a
  real regression.
- `AGENTS.md` §11 contains notes specific to a different downstream fork (`HenkDz/paperclip`,
  built-in Hermes adapters, port 3101, NTFS workarounds). Those do not apply to this
  checkout unless you are on that fork's branches — ignore them here.
