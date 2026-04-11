# Relay Extension V1 Plan

## Summary

Implement Relay as a desktop-only VS Code extension with:

- an Activity Bar entry
- a single webview-based sidebar UI
- an in-process localhost HTTP server used by the webview as its backend
- persistent cache/data storage under VS Code extension storage
- OTEL-style spans and structured logs emitted by frontend and backend

The first implementation is read-only and focused on:

- org URL entry
- project discovery
- recent build browsing
- build summary drill-in

## Core Architecture

- Start the extension backend during activation.
- Bind the Relay API server to `127.0.0.1` on an ephemeral port.
- Pass the chosen API base URL into the webview bootstrap payload.
- Use `ADO_TOKEN` from the VS Code process environment for ADO auth.
- If `ADO_TOKEN` is missing, keep the UI available but return an auth-required error state for ADO-backed routes.

## Backend

- Expose Relay-owned endpoints instead of a generic raw proxy.
- Initial routes:
  - `GET /api/session`
  - `GET /api/org/projects`
  - `GET /api/projects/:projectId/builds?limit=10`
  - `GET /api/builds/:buildId`
  - `POST /api/cache/refresh`
  - `POST /api/telemetry`
- Keep the v1 backend read-only.
- Server-side ADO request construction owns URL generation and auth injection.

## Cache and Storage

- Use `ExtensionContext.globalStorageUri` as the persistent base.
- Store Relay data under:
  - `<globalStorage>/.relay/`
- Store build-specific data under:
  - `<globalStorage>/.relay/build/<buildId>/`
- Write a `timestamp` file inside each build folder after successful build retrieval.
- Cache key format:
  - `METHOD + normalized full ADO URL`
- Serve cached data whenever:
  - the entry exists
  - the request is inside TTL
  - the user did not manually refresh

## TTL Defaults

- organization projects: `3600s`
- recent builds: `60s`
- build summary: `300s`

## Telemetry

- Start a local Relay telemetry sink alongside extension startup.
- Backend writes spans and structured logs directly to the sink.
- Webview posts telemetry payloads back to Relay through the local HTTP API.
- Sink output:
  - if `RELAY_OTEL_FOLDER` is set, write NDJSON traces/logs there
  - otherwise write NDJSON telemetry to stdout

## UI

- Use a single webview view in the Relay Activity Bar container.
- Left sidebar inside the webview:
  - target org URL input
  - connect/load action
  - manual refresh action
  - project button list
  - bottom-fixed theme picker
- Main area:
  - full-width project/recent-build view by default
  - auto 50/50 split on drill-down
  - build summary shown in the detail pane
- Theme system:
  - separate CSS files
  - one active stylesheet at a time
  - persisted theme selection

## Acceptance

- Extension activates and shows a Relay Activity Bar entry.
- The Relay sidebar loads and renders themed UI.
- Valid org URL loads projects.
- Clicking a project loads the last 10 builds.
- Clicking a build opens split view and shows build summary.
- Cache is reused inside TTL and bypassed on manual refresh.
- Build retrieval creates `.relay/build/<buildId>/timestamp`.
- Telemetry is emitted by both frontend and backend.
