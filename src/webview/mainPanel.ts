import * as vscode from "vscode";

import { RelayPanelBootstrap, RelayPersistedState, RelaySubview, ThemeId } from "../shared/types";

const STATE_KEY = "relay.uiState";

export class RelayMainPanel {
  private panel?: vscode.WebviewPanel;
  private apiBase = "";
  private serverReady = false;
  private serverMessage = "Starting local Relay API...";

  constructor(private readonly context: vscode.ExtensionContext) {}

  open(project?: string, view: RelaySubview = "builds"): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      this.panel.webview.postMessage({
        type: "openProject",
        project,
        view
      });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "relay.main",
      project ? `Azure DevOps Relay: ${project}` : "Azure DevOps Relay",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });

    this.panel.webview.html = this.renderHtml(this.panel.webview, project, view);
  }

  postTheme(themeId: ThemeId): void {
    this.panel?.webview.postMessage({
      type: "themeChanged",
      themeId
    });
  }

  postServerReady(apiBase: string): void {
    this.apiBase = apiBase;
    this.serverReady = true;
    this.serverMessage = "";
    this.panel?.webview.postMessage({
      type: "serverReady",
      apiBase
    });
  }

  postServerError(message: string): void {
    this.serverReady = false;
    this.serverMessage = message;
    this.panel?.webview.postMessage({
      type: "serverError",
      message
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const typed = message as { type?: string; state?: Partial<RelayPersistedState>; title?: string; path?: string; url?: string };
    if (typed.type === "persistState" && typed.state) {
      const current = this.getState();
      const next: RelayPersistedState = {
        activeTheme: isThemeId(typed.state.activeTheme) ? typed.state.activeTheme : current.activeTheme,
        orgUrl: typeof typed.state.orgUrl === "string" ? typed.state.orgUrl : current.orgUrl
      };
      await this.context.globalState.update(STATE_KEY, next);
      return;
    }

    if (typed.type === "setTitle" && typeof typed.title === "string" && this.panel) {
      this.panel.title = typed.title;
      return;
    }

    if (typed.type === "chooseFolder" && this.panel) {
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Use Folder"
      });
      this.panel.webview.postMessage({
        type: "folderChosen",
        folder: selection?.[0]?.fsPath ?? ""
      });
      return;
    }

    if (typed.type === "openLogFile" && typeof typed.path === "string" && typed.path) {
      const document = await vscode.workspace.openTextDocument(typed.path);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
      });
      return;
    }

    if (typed.type === "openExternalUrl" && typeof typed.url === "string" && typed.url) {
      await vscode.env.openExternal(vscode.Uri.parse(typed.url));
    }
  }

  private renderHtml(webview: vscode.Webview, initialProject?: string, initialView: RelaySubview = "builds"): string {
    const nonce = createNonce();
    const state = this.getState();
    const bootstrap: RelayPanelBootstrap = {
      apiBase: this.apiBase || undefined,
      telemetryBase: this.apiBase || undefined,
      serverReady: this.serverReady,
      serverMessage: this.serverMessage || undefined,
      savedState: state,
      themeIds: ["githubdark", "neon", "nightwave", "ember"],
      themeUrls: {
        githubdark: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-githubdark.css")).toString(),
        neon: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-neon.css")).toString(),
        nightwave: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-nightwave.css")).toString(),
        ember: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-ember.css")).toString()
      },
      initialProject,
      initialView
    };
    const baseCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "base.css"));
    const initialTheme = bootstrap.themeUrls[state.activeTheme];
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.js"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} http://127.0.0.1:*`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Azure DevOps Relay</title>
  <link rel="stylesheet" href="${baseCss}" />
  <link rel="stylesheet" id="theme-css" href="${initialTheme}" />
</head>
<body class="relay-panel">
  <main class="content content--main panel-shell" id="content">
    <section id="main-panel" class="panel panel--main">
      <div id="panel-blocker" class="startup-blocker${this.serverReady ? " is-hidden" : ""}">
        <div class="startup-blocker__panel">
          <div class="spinner" aria-hidden="true"></div>
          <div class="startup-blocker__title">Starting Relay</div>
          <div id="panel-blocker-message" class="startup-blocker__message">${escapeHtml(this.serverMessage || "Starting local Relay API...")}</div>
        </div>
      </div>
      <span id="main-status-corner" class="panel-corner is-hidden" aria-hidden="true"></span>
      <div class="panel__header">
        <div>
          <p id="main-kind" class="eyebrow">Project</p>
          <h2 id="main-title">Awaiting project selection</h2>
        </div>
        <div class="panel__header-actions">
          <button id="main-cache-pill" class="pill pill--button">Idle</button>
          <div id="main-status" class="status-copy">Choose a project from the Azure DevOps Relay sidebar.</div>
        </div>
      </div>
      <div id="toolbar" class="toolbar is-hidden"></div>
      <div id="message-banner"></div>
      <div id="build-list" class="build-list empty-state">
        No project selected.
      </div>
    </section>
    <section class="panel panel--detail is-hidden" id="detail-panel">
      <span id="detail-status-corner" class="panel-corner is-hidden" aria-hidden="true"></span>
      <div class="panel__header">
        <div>
          <p id="detail-kind" class="eyebrow">Build</p>
          <h2 id="detail-title">No build selected</h2>
        </div>
        <div class="panel__header-actions">
          <button id="detail-cache-pill" class="pill pill--button">Idle</button>
          <button id="close-detail" class="button button--ghost">Close</button>
        </div>
      </div>
      <div id="detail-body" class="detail-grid empty-state">
        Choose a build to inspect.
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    window.__RELAY_BOOTSTRAP__ = ${JSON.stringify(bootstrap)};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getState(): RelayPersistedState {
    const stored = this.context.globalState.get<RelayPersistedState>(STATE_KEY);
    return {
      activeTheme: isThemeId(stored?.activeTheme) ? stored.activeTheme : "githubdark",
      orgUrl: stored?.orgUrl ?? ""
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function isThemeId(value: unknown): value is ThemeId {
  return value === "githubdark" || value === "neon" || value === "nightwave" || value === "ember";
}
