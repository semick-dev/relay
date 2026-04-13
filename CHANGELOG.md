# Changelog

## 0.0.8

- Add queue capabilities to the `build list` (EGviewing a build definition) pane

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
