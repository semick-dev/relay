# Contributing

## Local Development

Expected environment:

- `ADO_TOKEN` set before launching VS Code
- optional `RELAY_OTEL_FOLDER` for persisted telemetry output

Install dependencies and build:

```bash
npm install
npm run build
```

## Local Debugging

This repo includes [.vscode/launch.json](/home/semick/repo/relay/.vscode/launch.json:1) with an `extensionHost` configuration named `Run Relay Extension`.

Use that launch configuration to start an Extension Development Host directly from VS Code. This lets you debug the extension locally without packaging a VSIX first.

The launch configuration forwards:

- `ADO_TOKEN`
- `RELAY_OTEL_FOLDER`

## Packaging

Create a local Marketplace package with:

```bash
npm run marketplace:package
```

## Publishing

Publishing instructions are kept in the private `publishing.md` file in this repo.
