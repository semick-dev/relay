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
12. [plans/build_layout.md](/home/semick/repo/relay/plans/build_layout.md)
13. [plans/artifacts_layout.md](/home/semick/repo/relay/plans/artifacts_layout.md)

If you only have 5 minutes, read `src/extension.ts`, `src/server/apiServer.ts`, `media/panel.js`, and `media/base.css`.

## What This Repo Is

This is a desktop-only VS Code extension named `Relay`. It is an Activity Bar-first Azure DevOps build UI replacement.

High-level shape:

- left sidebar webview for org URL, projects, theme switching
- main webview panel for definitions, build lists, build details, task logs, artifacts
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
- creates `RelayAdoClient` with `process.env.ADO_TOKEN`
- creates and starts `RelayApiServer`
- creates `RelayMainPanel`
- registers `RelaySidebarProvider`

The extension assumes `ADO_TOKEN` is already in the VS Code process environment.

### UI split

Sidebar:

- [src/webview/provider.ts](/home/semick/repo/relay/src/webview/provider.ts)
- [media/main.js](/home/semick/repo/relay/media/main.js)

Main panel:

- [src/webview/mainPanel.ts](/home/semick/repo/relay/src/webview/mainPanel.ts)
- [media/panel.js](/home/semick/repo/relay/media/panel.js)

The sidebar never talks to ADO directly. The main panel never talks to ADO directly. Everything goes through the local API server.

## Current UX Model

### Sidebar

The sidebar is the control surface. It currently provides:

- org URL entry
- `Load Projects`
- project list
- per-project sub-buttons:
  - `Definitions`
  - `Artifacts`
- theme picker
- clickable cache pill for the project list

Current header copy:

- eyebrow: `Azure DevOps`
- title: `Relay`

### Main panel

The main panel is the real work area.

Current navigation shape:

1. Open a project in `Definitions`
2. Click a definition
3. Right 50% pane becomes definition-scoped build list
4. Click a build
5. Main panel becomes full build page
6. Click a task
7. Right 50% pane becomes task output pane
8. Click `Artifacts` inside build details
9. Right 50% pane becomes artifacts pane

Important behaviors:

- `Ctrl+F` is enabled on the main webview panel via `enableFindWidget`
- mouse/browser back is used for panel navigation
- clickable cache pills are the refresh affordance
- non-button UI is intentionally square, not rounded

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

Important endpoints:

- `GET /api/session`
- `GET /api/org/projects`
- `GET /api/projects/:project/builds`
- `GET /api/projects/:project/definitions`
- `GET /api/projects/:project/definitions/status`
- `POST /api/projects/:project/definitions/precache`
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
- timeline fetch
- raw log fetch
- build changes fetch for commit message
- artifact listing/download

Important implementation detail:

- build list rows get their commit message from `builds/{id}/changes`, not from the plain build object

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
- UI theme ids
- core ADO-derived entities like builds, definitions, timeline nodes, artifacts

## Frontend Entry Points

### Sidebar script

[media/main.js](/home/semick/repo/relay/media/main.js)

Owns:

- org URL entry
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
- build filter chips
- build detail rendering
- timeline/task tree rendering
- task pane loading
- large-log deferred download behavior
- artifacts pane rendering
- navigation/history
- cache-pill behavior in main and detail panes

If a UI bug exists, there is a high chance it is in this file.

### Styling

[media/base.css](/home/semick/repo/relay/media/base.css)

This is the shared visual system.

Current visual rules:

- square corners on non-button UI
- buttons and pills still have rounded treatment
- terse, text-heavy list styling for definitions and task tree
- build rows are compact, with a colored status square in the top-right corner

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
- only definition rows are clickable
- there is a loading spinner while definitions are loading
- the old definitions warmup bar was removed

### Definition-scoped builds

- build rows are compact and square
- row shape is:
  - `#<id> · <buildNumber> · <definitionName>`
  - commit message on its own muted line
  - branch / requester / time below
- colored status square sits at top-right of each row
- build filters:
  - `All`
  - `In Progress`
  - `Failed / Cancelled`
  - `Success`

### Build details

- full-pane build page
- build details fold is collapsible
- timeline is rendered as a terse ASCII-like tree
- task clicks open right-side detail pane

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
- downloaded artifact state is persisted under `artifacts-downloads.json`
- if saved file disappears from disk, backend clears stale download state

## Known Rough Edges

Things I would assume are most likely to need attention next:

- `media/panel.js` is doing a lot and is the main complexity hotspot
- the sidebar HTML in `src/webview/provider.ts` has a suspicious extra closing `</aside>` near the bottom and should be cleaned up
- `relay.refresh` in `src/extension.ts` still shows a message about a button that no longer exists
- definitions precache job plumbing still exists on the backend even though the visible warmup bar was removed
- task/build/artifact flows are functional, but the frontend is still fairly stateful and hand-rolled

## Plans And Design Intent

Read these before changing layout behavior:

- [plans/2026-04-10-relay-extension-v1.md](/home/semick/repo/relay/plans/2026-04-10-relay-extension-v1.md)
- [plans/build_layout.md](/home/semick/repo/relay/plans/build_layout.md)
- [plans/artifacts_layout.md](/home/semick/repo/relay/plans/artifacts_layout.md)

They reflect the intended direction for build and artifact views.

## Build / Run

Expected environment:

- `ADO_TOKEN` must be present before launching VS Code
- `RELAY_OTEL_FOLDER` is optional

Build:

```bash
npm run build
```

Run:

- use the VS Code Extension Development Host
- open the Relay Activity Bar icon

## Fast Mental Model

If you need a one-paragraph model:

`src/extension.ts` boots a localhost ADO proxy/cache server plus two webviews. `src/server/apiServer.ts` is the backend brain, `src/server/adoClient.ts` is the thin ADO transport, `src/server/storage.ts` and `src/server/cacheStore.ts` persist things, `media/main.js` drives the sidebar, `media/panel.js` drives everything else, and `media/base.css` is the shared UI language. Build-local persisted artifacts, timelines, and logs live under `.relay/build/<buildId>/`.
