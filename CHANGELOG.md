# Changelog

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
