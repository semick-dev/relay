# Changelog

## 0.0.14

This update all about perceived performance fixes.

- Parallel load of api server increases perceived startUp time.
- Optimized module load order.
- Remove blocking definition calls.
- Bundle the extension host into a single shipped runtime file.
- Bundle and minify the sidebar and main-panel webview scripts.
- Move storage setup, token lookup, telemetry init, and API runtime startup fully behind immediate UI/command registration during activation.


## 0.0.13

- Fixed task log loading so large task outputs no longer auto-open inline in the task details pane
- Changed task output previews to inline only up to 50KB, with larger logs requiring an explicit download before opening
- Updated the large-log task pane action to show download state and switch to `Show Log` after the file is saved locally
- Add Github PR link to build details page.
- Add infinite scroll to the builds list.
- Add selectable mass cancellation in the builds list.
- `Cancelled` status now displays as `gray` in chips.
- Layout cleanup for the `Queue This Build` tab of the builds list.


## 0.0.12

- Reused cached build definitions across Relay sessions instead of forcing a full definitions reload after the short in-memory freshness window elapsed
- Fixed the definitions refresh path to avoid immediately re-fetching definitions again after the precache job completed

## 0.0.11

- Updates to the readme RE: setting the token being used
- Cleanups of stale code paths that won't work
- Improvements to error logging on bad PAT settings
- Build definitions and build details ascii layouts now share common code.
  - And apply heavy refactoring to the collapsible section appearance of both.
  - Should be much more performant on first load within VSCode UI

## 0.0.10

- Resolving #6, #9, #4, #5, #10

## 0.0.9

- Fix broken extension load. External environment variables aren't getting honored and I cbfed to understand why. Just swapped to using secret storage, which is far better anyway as now you don't have to remember to set the token again from a fresh console window. Much better this way.

## 0.0.8

- Add queue capabilities to the `build list` (EGviewing a build definition) pane
  - This mode is simply first pass at this point. Need to properly parse yaml -> convert to JSON automagically etc etc etc. I cbf to deal with it rn

## 0.0.7

- Fix various alignment and spacing issues across all panels
- Update definition and build click actions to feel more responsive
  - Panels render async now
- Add commit message to relevant locations
- Refine the `Build Details` pane look/feel

## 0.0.6

- Fixed Azure DevOps definitions paging to use explicit `queryOrder=lastModifiedDescending` with continuation tokens to fix when paging is required from `definitions`
- Surfaced raw Azure DevOps error text in failed HTTP responses for easier diagnosis
- Returned cached definitions immediately instead of waiting on background precache when the cache is already fresh
- Changed the definition name glob filter to apply on `Enter` or focus loss instead of every keystroke
- Removed the redundant build-list pane `Back` button and stopped stacking definition build-list history entries while switching definitions

## 0.0.5

- Resolve readme confusion

## 0.0.4

- Change demo image to external image

## 0.0.3

- Rewrote the public README to focus on the shipped extension experience.
- Moved local development and debugging instructions into `CONTRIBUTING.md`.
- Added contributor guidance for running the extension from `.vscode/launch.json` without packaging first.
= Added details regarding storage location in `README.md`.

## 0.0.2

- Renamed the published extension to `ado-relay` with the display name `Azure DevOps Relay`.
- Simplified the Marketplace description to `An Azure DevOps interface.`
- Tightened VSIX packaging to include only shipped runtime assets.
- Improved missing `ADO_TOKEN` messaging in the sidebar.
- Fixed task log behavior so large logs require explicit download and repeated opens reuse the same in-flight download.

## 0.0.1

- Initial Marketplace release of Azure DevOps Relay.
