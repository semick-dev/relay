# relay

A cache-heavy local UI for fast interaction with ADO projects. Makes grepping through logs _extremely_ easy.

https://github.com/user-attachments/assets/6ae4ba7d-af43-40e9-b1f7-e1ae80c4af1a

## Current shape

This repo now contains the first-pass VS Code extension scaffold for Azure DevOps Relay:

- Activity Bar container with a single webview-based UI
- In-process localhost API server for all webview data access
- Persistent cache rooted at VS Code `globalStorageUri`
- Build-specific cache folders under `.relay/build/<buildId>/`
- Local telemetry sink that writes NDJSON under `RELAY_OTEL_FOLDER` or falls back to stdout
- Themeable webview UI with multiple CSS theme files

## Development

Expected environment:

- `ADO_TOKEN` set before launching VS Code
- optional `RELAY_OTEL_FOLDER` for persisted telemetry output

Build:

```bash
npm install
npm run build
```

Then open the repo in VS Code and run the extension in an Extension Development Host.
