# Publishing

Azure DevOps Relay is packaged and published as the VS Code extension `semick-dev.ado-relay`.

Prerequisites:

- a Visual Studio Marketplace publisher with ID `semick-dev`
- Marketplace account email `sbeddall@live.com`
- Marketplace user ID `7925c4ba-3a6c-4484-bcbf-6656030c5284` for the Scott Beddall account
- an Azure DevOps Personal Access Token with scope `Marketplace (Manage)` and organization set to `All accessible organizations`
- Node.js installed locally

Account notes:

- sign in to Azure DevOps and Visual Studio Marketplace as `sbeddall@live.com`
- create the PAT while signed in as `sbeddall@live.com`
- keep using publisher ID `semick-dev` with `vsce`; the Marketplace user ID `7925c4ba-3a6c-4484-bcbf-6656030c5284` is account identity data, not the publisher ID passed to `vsce login`

Install the publishing tool:

```bash
npm install -g @vscode/vsce
```

Authenticate the publisher:

```bash
vsce login semick-dev
```

When prompted, provide the PAT created under `sbeddall@live.com`.

Before each release:

1. Update the `version` in `package.json`.
2. Review `README.md`, `CHANGELOG.md`, and extension metadata.
3. Make sure the repo builds cleanly.

Local validation:

```bash
npm install
npm run build
```

Create a Marketplace package:

```bash
npm run marketplace:package
```

Install the generated VSIX locally for a smoke test:

```bash
code --install-extension ado-relay-0.0.1.vsix
```

Publish to the Visual Studio Marketplace:

```bash
npm run marketplace:publish
```

Expected publish identity:

- Marketplace account: `sbeddall@live.com`
- Marketplace user ID: `7925c4ba-3a6c-4484-bcbf-6656030c5284`
- VS Code publisher ID: `semick-dev`
- Published extension ID: `semick-dev.ado-relay`

If you prefer the direct CLI flow instead of the npm scripts, run:

```bash
npx @vscode/vsce package
npx @vscode/vsce publish
```
