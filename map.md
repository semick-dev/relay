# Relay Repo Map

This is the repo map I would want if I were the next Codex instance dropped into this workspace.

## Start Here

Read files in this order:

1. [AGENTS.md](/home/semick/repo/relay/AGENTS.md)
2. [package.json](/home/semick/repo/relay/package.json)
3. [src/extension.ts](/home/semick/repo/relay/src/extension.ts)
4. [src/shared/types.ts](/home/semick/repo/relay/src/shared/types.ts)
5. [src/server/apiServer.ts](/home/semick/repo/relay/src/server/apiServer.ts)
6. [src/server/adoClient.ts](/home/semick/repo/relay/src/server/adoClient.ts)
7. [src/webview/provider.ts](/home/semick/repo/relay/src/webview/provider.ts)
8. [src/webview/mainPanel.ts](/home/semick/repo/relay/src/webview/mainPanel.ts)
9. [media/main.js](/home/semick/repo/relay/media/main.js)
10. [media/panel.js](/home/semick/repo/relay/media/panel.js)
11. [media/base.css](/home/semick/repo/relay/media/base.css)
12. [plans/2026-04-12-ado-definition-12-queue-notes.md](/home/semick/repo/relay/plans/2026-04-12-ado-definition-12-queue-notes.md)
13. [plans/build_layout.md](/home/semick/repo/relay/plans/build_layout.md)
14. [plans/artifacts_layout.md](/home/semick/repo/relay/plans/artifacts_layout.md)

If you only have 5 minutes, read `src/extension.ts`, `src/server/apiServer.ts`, `src/server/adoClient.ts`, `media/panel.js`, and `media/base.css`.

## What This Repo Is

This is a desktop-only VS Code extension packaged as:

- package name: `ado-relay`
- display name: `Azure DevOps Relay`
- publisher: `semick-dev`

High-level shape:

- left sidebar webview for org URL, auth state, projects, theme switching
- main webview panel for definitions, build lists, queueing, build details, task logs, artifacts
- localhost HTTP API started inside the extension host
- all ADO traffic goes through that local API
- persistent cache stored under VS Code global storage
- OTEL-like telemetry emitted by both backend and frontend into a local sink

## Runtime Flow

### Activation

[src/extension.ts](/home/semick/repo/relay/src/extension.ts)

On activation:

- ensures `globalStorageUri` exists
- creates `RelayTelemetrySink`
- creates `RelayStorage`
- creates `RelayCacheStore`
- loads ADO token from VS Code secrets
- creates `RelayAdoClient`
- creates `RelayApiServer`
- creates `RelayMainPanel`
- registers `RelaySidebarProvider`
- registers commands:
  - `relay.refresh`
  - `relay.setToken`
  - `relay.clearToken`
- starts the local API server in the background and posts the resolved `apiBase` into any open webviews once the port is ready

Important current behavior:

- token storage is secret-backed, not environment-only
- the sidebar can request token setup interactively
- extension activation no longer blocks UI render on `RelayApiServer.start()`

### UI split

Sidebar:

- [src/webview/provider.ts](/home/semick/repo/relay/src/webview/provider.ts)
- [media/main.js](/home/semick/repo/relay/media/main.js)

Main panel:

- [src/webview/mainPanel.ts](/home/semick/repo/relay/src/webview/mainPanel.ts)
- [media/panel.js](/home/semick/repo/relay/media/panel.js)

Neither webview talks to Azure DevOps directly. Everything goes through the local API server.

Current bootstrap behavior:

- both webviews can render before the local API server has chosen a port
- `src/shared/types.ts` bootstrap payload now includes `serverReady` plus an optional startup message
- the extension posts `serverReady` / `serverError` messages after background server startup settles
- `media/main.js` and `media/panel.js` keep the UI in a blocked gray startup state until `apiBase` is injected

## Current UX Model

### Sidebar

The sidebar is the control surface. It currently provides:

- org URL entry
- `Load Projects`
- token-required empty state with `Set Token` when auth is missing
- project list
- per-project sub-buttons:
  - `Definitions`
  - `Artifacts`
- theme picker
- clickable cache pill for the project list

Current header copy:

- eyebrow: `Azure DevOps`
- title: `Azure DevOps Relay`

### Main panel

The main panel is the real work area.

Current navigation shape:

1. Open a project in `Definitions`
2. Browse definitions as a terse tree
3. Click a definition
4. Right detail pane opens with tabs:
   - `List Builds for Definition`
   - `Queue Definition`
5. Click a build from the list tab
6. Main panel becomes the build details page
7. Click a task
8. Right detail pane becomes task output
9. Click `Artifacts`
10. Right detail pane becomes artifacts pane

Important behaviors:

- the definition detail pane splits immediately and shows loading states while build lists load
- the build page renders immediately and shows a loading state while build details/timeline load
- cache pills are the refresh affordance
- queueing a YAML-backed definition navigates directly to the queued build details page on success
- visible errors in the panel are dismissible
- GitHub pull-request builds can derive an `Open Pull Request` action from cached build metadata: `repositoryId`/`repositoryUrl`, `reason = pullRequest`, and `triggerInfo["pr.number"]` with `refs/pull/<n>/...` as fallback
- definition-scoped build lists are paged; scrolling near the bottom appends the next batch using ADO continuation tokens, and the list tab exposes a `Batch Size` control for the per-fetch page size
- the definition build-list tab also supports a `Selection` mode for bulk cancellation; active builds can be selected across already-loaded and newly-appended rows and cancelled together without leaving the list

## Backend Layout

### API server

[src/server/apiServer.ts](/home/semick/repo/relay/src/server/apiServer.ts)

This is the main backend coordinator.

It owns:

- route dispatch
- cache policy
- build-local file reads/writes
- definitions precache job tracking
- shaping responses for the webviews
- non-cached queue metadata and queue submission routes

Important endpoints:

- `GET /api/session`
- `GET /api/org/projects`
- `GET /api/projects/:project/builds`
- `GET /api/projects/:project/definitions`
- `GET /api/projects/:project/definitions/status`
- `POST /api/projects/:project/definitions/precache`
- `GET /api/projects/:project/definitions/:definitionId/queue-metadata`
- `POST /api/projects/:project/definitions/:definitionId/queue`
- `GET /api/builds/:buildId`
- `GET /api/builds/:buildId/timeline`
- `GET /api/builds/:buildId/logs/:logId/meta`
- `GET /api/builds/:buildId/logs/:logId`
- `GET /api/builds/:buildId/artifacts`
- `POST /api/builds/:buildId/artifacts/download`
- `POST /api/cache/refresh`
- `POST /api/telemetry`

### ADO client

[src/server/adoClient.ts](/home/semick/repo/relay/src/server/adoClient.ts)

This is the thin REST client.

It owns:

- ADO auth
- project listing
- build listing/details
- build definitions listing
- YAML pipeline queue metadata lookup
- YAML pipeline preview lookup for parameter discovery
- YAML pipeline queueing via `pipelines/{id}/runs`
- timeline fetch
- raw log fetch
- build changes fetch for commit message
- artifact listing/download

Important implementation details:

- build list rows get commit messages from `builds/{id}/changes`
- build details now persist extra source metadata needed for PR derivation: `sourceVersion`, `repository.id/type/url`, and string-valued `triggerInfo`
- queueable variables are filtered to `allowOverride`
- YAML parameter metadata is currently derived from `POST /_apis/pipelines/{id}/preview`
- queue submission uses `templateParameters` plus `variables`
- object/list parameter textarea values are parsed with the `yaml` package before submission

### Generic cache

[src/server/cacheStore.ts](/home/semick/repo/relay/src/server/cacheStore.ts)

This is the URL-keyed JSON cache for REST-backed resources.

Rules:

- key = `METHOD + normalized URL`
- normalized URL lowercases host and sorts query params
- body and metadata are stored separately under `.relay/cache`
- TTL freshness is checked here

Current TTLs live in `src/server/apiServer.ts`:

- projects: `3600`
- builds: `60`
- build: `300`
- definitions: `900`

### Build-local storage

[src/server/storage.ts](/home/semick/repo/relay/src/server/storage.ts)

This is the file-oriented layer for build-local persistence.

Important methods:

- `writeBuildJson`
- `readBuildJson`
- `writeBuildText`
- `readBuildText`
- `hasBuildFile`
- `getBuildFilePath`
- `writeBuildTimestamp`
- `readBuildTimestamp`

## Persistent Files On Disk

Storage root:

- VS Code `globalStorageUri/.relay`

Main folders:

- `.relay/cache/`
- `.relay/build/<buildId>/`

Typical build-local files:

- `timestamp`
- `timeline.json`
- `artifacts.json`
- `artifacts-downloads.json`
- `logs/<logId>.txt`

Current behavior:

- completed builds prefer local cached timeline/artifact/task-log data
- large task logs are stored as plain `.txt`
- large cached task logs stay file-backed in the UI
- `Show Log` opens the saved `.txt` in VS Code beside the Relay panel

## Telemetry

[src/server/telemetry.ts](/home/semick/repo/relay/src/server/telemetry.ts)

This is not a full collector. It is an in-process sink.

Behavior:

- if `RELAY_OTEL_FOLDER` is set, writes NDJSON into `<folder>/<sessionId>/`
- otherwise writes NDJSON to stdout
- frontend posts telemetry to `/api/telemetry`
- backend writes directly through the sink

Common trace/log points:

- activation
- server start
- HTTP requests
- cache decisions
- fetches
- errors

## Shared Types

[src/shared/types.ts](/home/semick/repo/relay/src/shared/types.ts)

Read this before making any API or UI contract changes.

It contains:

- bootstrap payloads for sidebar/panel webviews
- all API response shapes
- queue metadata / queue request / queue response contracts
- UI theme ids
- core ADO-derived entities like builds, definitions, timeline nodes, artifacts

## Frontend Entry Points

### Sidebar script

[media/main.js](/home/semick/repo/relay/media/main.js)

Owns:

- org URL entry
- auth-required state
- project loading
- sidebar state persistence
- project action clicks
- theme picker
- sidebar cache pill

### Main panel script

[media/panel.js](/home/semick/repo/relay/media/panel.js)

This is the busiest file in the repo.

It owns:

- project opening
- definition loading/filtering/tree rendering
- definition-scoped build list rendering
- queue tab rendering and interaction
- build filter chips
- build detail rendering
- timeline/task tree rendering
- task pane loading
- large-log deferred download behavior
- artifacts pane rendering
- navigation/history
- cache-pill behavior in main and detail panes
- panel-local and global dismissible error handling

If a UI bug exists, there is a high chance it is in this file.

### Styling

[media/base.css](/home/semick/repo/relay/media/base.css)

This is the shared visual system.

Current visual rules:

- square corners on non-button UI
- buttons and pills still have rounded treatment
- terse, text-heavy list styling for definitions and task tree
- build rows are compact, with a colored status square in the top-right corner
- definition detail tabs use attached square tab styling

Themes:

- [media/theme-githubdark.css](/home/semick/repo/relay/media/theme-githubdark.css) is the default
- other themes:
  - `neon`
  - `nightwave`
  - `ember`

## Current Important Behaviors

### Definitions

- definitions are shown as a terse tree, not button cards
- filter supports case-insensitive text plus `*` wildcard patterns
- filter applies on `Enter` or blur, not on every keystroke
- only definition rows are clickable
- there is a loading spinner while definitions are loading
- a visible root node `All Matching Build Definitions` starts the tree
- folder-only nodes render with a trailing `/`

### Definition-scoped builds

- build list and queue flow live behind tabs
- build rows are compact and square
- row shape is:
  - `#<id> · <buildNumber> · <definitionName>`
  - commit message on its own muted line
  - branch / requester / time below
- commit messages are truncated in the list with hover title only when truncated
- colored status square sits at top-right of each row
- build filters:
  - `All`
  - `In Progress`
  - `Failed / Cancelled`
  - `Success`

### Queue definition

- queueing support is intended for YAML-backed definitions
- user provides branch/ref first, then prepares queue inputs
- branch-aware parameter metadata is loaded before run
- parameters render as textareas seeded from defaults
- variables render as editable name/value rows
- queue errors are local to the queue tab and dismissible
- successful queue navigates directly to the queued build page

### Build details

- full-pane build page
- summary card fold is collapsible
- timeline heading is `Build Timeline`
- timeline is rendered as a terse ASCII-like tree
- task clicks open the right-side detail pane

### Task logs

- small logs render inline
- large logs do not auto-render
- if large and not yet downloaded:
  - UI shows `Download Task Output`
- if large and already downloaded:
  - UI shows local path
  - UI shows `Show Log`
  - no inline render, even from cache

### Artifacts

- artifacts open in the right 50% pane
- user chooses target folder via host dialog
- each artifact shows download state
- clicking `Download` immediately disables the artifact button and switches it to `Downloading...` until the saved-path state comes back, then the row flips to the green downloaded check
- downloaded artifact state is persisted under `artifacts-downloads.json`
- if saved file disappears from disk, backend clears stale download state

## Known Rough Edges

Things I would assume are most likely to need attention next:

- `media/panel.js` is still the main complexity hotspot
- `src/webview/provider.ts` still has a stray extra closing `</aside>` in the rendered HTML
- queueing is now functional, but YAML parameter discovery is a subtle area and should be rechecked carefully when new pipeline shapes are introduced
- definitions precache job plumbing still exists on the backend even though the visible warmup bar is gone

## Plans And Design Intent

Read these before changing layout behavior:

- [plans/2026-04-10-relay-extension-v1.md](/home/semick/repo/relay/plans/2026-04-10-relay-extension-v1.md)
- [plans/build_layout.md](/home/semick/repo/relay/plans/build_layout.md)
- [plans/artifacts_layout.md](/home/semick/repo/relay/plans/artifacts_layout.md)
- [plans/2026-04-12-ado-definition-12-queue-notes.md](/home/semick/repo/relay/plans/2026-04-12-ado-definition-12-queue-notes.md)

Those reflect the intended direction for build, artifact, and queue behavior.

## Build / Run

Expected environment:

- `RELAY_OTEL_FOLDER` is optional

Build:

```bash
npm run build
```

Run:

- use the VS Code Extension Development Host
- open the Azure DevOps Relay Activity Bar icon

## Fast Mental Model

If you need a one-paragraph model:

`src/extension.ts` boots a localhost ADO proxy/cache server plus two webviews. `src/server/apiServer.ts` is the backend brain, `src/server/adoClient.ts` is the thin ADO transport plus YAML queueing adapter, `src/server/storage.ts` and `src/server/cacheStore.ts` persist things, `media/main.js` drives the sidebar, `media/panel.js` drives almost everything else, and `media/base.css` is the shared UI language. Build-local persisted artifacts, timelines, and logs live under `.relay/build/<buildId>/`.
