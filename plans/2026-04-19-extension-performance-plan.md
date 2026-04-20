# Relay Extension Performance Plan

Goal: improve perceived and actual performance without regressing the recent UI fixes around build details, task details, artifacts, and definition build paging.

## Startup Optimization Batch

- [x] 1. Bundle the extension host code so activation pays one bundled module load instead of a larger CommonJS file graph.
- [x] 2. Bundle the webview scripts so sidebar/main-panel startup uses built assets instead of raw source files.
- [x] 3. Minify the shipped extension host and webview bundles as part of the build pipeline.
- [x] 4. Delay more activation-time work by registering the UI first and initializing storage, telemetry, secrets, and the local API runtime in the background.
- [x] 5. Audit and reduce synchronous startup work in `activate()` so the remaining path is mostly object creation, command registration, and a background runtime kickoff.

## Priority Order

- [x] 6. Lazy-import `yaml` so queue-only parsing code does not inflate extension activation/module load cost.
- [x] 2. Kill the build-list N+1 enrichment path so definition build pages do not fan out into per-build change lookups on initial list fetch or paging append.
- [x] 1. Stop blocking project open on definitions precache so cached definitions can render immediately and background refresh can fill in newer data afterward.

## 6. Lazy-Import `yaml`

Current issue:
- `src/server/adoClient.ts` imports `yaml` at module load.
- Most users do not need YAML parsing until they open `Queue This Build` and prepare queue metadata.

Implementation:
- [x] Move `yaml` usage behind a dynamic import in the queue-metadata / template-parameter parsing path.
- [x] Keep the parsing helpers cohesive so the import happens once and is reused.
- [x] Ensure import failure surfaces as a normal queue-preparation error, not an activation failure.

Validation:
- [x] Extension still activates and renders sidebar/main panel without queue interaction.
- [x] Queue metadata still resolves YAML parameters correctly once queue flow is used.

## 2. Kill Build-List N+1 Enrichment

Current issue:
- Definition build list fetches are enriched with per-build change text.
- This multiplies ADO calls by the number of builds in the page and gets worse with infinite scroll.

Implementation:
- [x] Remove per-build change fetching from the primary build-list response path.
- [x] Keep build rows renderable from summary data alone.
- [ ] Decide whether commit text should:
  - [ ] be omitted in the list when not already cached, or
  - [ ] be loaded lazily for visible rows only, or
  - [ ] be served only from previously cached build metadata.
- [x] Ensure infinite scroll append uses the same non-N+1 path.

Validation:
- [x] First-page build list load makes one build-list request, not one-plus-N change requests.
- [x] Infinite scroll append remains functional with the same pagination/continuation behavior.
- [ ] Build details page still loads the detailed build/task/timeline experience correctly when a row is opened.

## 1. Stop Blocking Project Open On Definitions Precache

Current issue:
- Opening a project in definitions mode still waits on the precache kickoff/poll cycle before rendering the usable definition UI.

Implementation:
- [x] Change definitions open flow to cached-first rendering.
- [x] Load and render cached definitions immediately when available.
- [x] Start definitions precache/refresh in the background instead of blocking the first render.
- [x] Patch refreshed definitions into the tree when the background refresh finishes.
- [x] Preserve the current progress/status affordances so refresh work is still visible.

Validation:
- [x] Opening a project with cached definitions renders the tree immediately.
- [x] Background precache still updates progress and final freshness metadata.
- [ ] Opening a definition and loading its build list still works during or after background precache.

## Additional Performance Work

- [ ] 3. Make definitions precache incremental instead of treating refresh as a large all-or-nothing sweep.
- [ ] 4. Virtualize long definition/build/timeline lists to reduce DOM cost in the webviews.
- [ ] 5. Defer and cache YAML queue metadata harder by definition/branch so repeated queue preparation is cheaper.
- [ ] 7. Reduce webview rerender churn by updating local regions instead of replacing large sections when only small state changes.
- [ ] 8. Review telemetry cost and batch/sample if the local sink is adding measurable request overhead.
- [ ] 9. Apply stale-while-revalidate more consistently across projects, definitions, builds, and build details.

## Regression Test Plan

These should be added or strengthened before/during the work above so performance changes do not break recently-stabilized flows.

- [x] Add/expand API-server tests around definition build list fetches to assert the non-N+1 path.
- [x] Add tests for paged build-list continuation behavior so infinite scroll append remains correct.
- [x] Add tests for cached-first definitions loading and background refresh behavior.
- [x] Add tests for queue metadata / YAML parameter loading after lazy import.
- [x] Add regression coverage for the task-details/task-log loading flow so we do not reintroduce the download/show loop problem.
- [ ] Add regression coverage for artifact download state transitions so download disabled/loading/checkmark behavior stays intact.
- [ ] Add regression coverage for build detail open behavior from the definition build list so summary/detail state handoff remains correct.
- [ ] Add regression coverage for selection mode / bulk cancel interactions on the definition build list.

## Suggested Execution Sequence

- [x] Land tests that pin current task-log/task-detail/artifact/build-list behavior.
- [x] Implement 6. Lazy-import `yaml`.
- [x] Implement 2. Kill build-list N+1 enrichment.
- [x] Implement 1. Stop blocking project open on definitions precache.
- [ ] Re-run build/test and do a manual pass on:
  - [x] sidebar startup
  - [ ] definitions tree open
  - [ ] infinite scroll
  - [ ] build details
  - [ ] task details/log download
  - [ ] artifact download
