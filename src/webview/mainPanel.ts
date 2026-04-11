import * as vscode from "vscode";

import { RelayPanelBootstrap, RelayPersistedState, ThemeId } from "../shared/types";

const STATE_KEY = "relay.uiState";

export class RelayMainPanel {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly apiBase: string
  ) {}

  open(project?: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      this.panel.webview.postMessage({
        type: "openProject",
        project
      });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "relay.main",
      project ? `Relay: ${project}` : "Relay",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
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

    this.panel.webview.html = this.renderHtml(this.panel.webview, project);
  }

  postTheme(themeId: ThemeId): void {
    this.panel?.webview.postMessage({
      type: "themeChanged",
      themeId
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const typed = message as { type?: string; state?: Partial<RelayPersistedState>; title?: string };
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
    }
  }

  private renderHtml(webview: vscode.Webview, initialProject?: string): string {
    const nonce = createNonce();
    const state = this.getState();
    const bootstrap: RelayPanelBootstrap = {
      apiBase: this.apiBase,
      telemetryBase: this.apiBase,
      savedState: state,
      themeIds: ["neon", "nightwave", "ember"],
      themeUrls: {
        neon: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-neon.css")).toString(),
        nightwave: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-nightwave.css")).toString(),
        ember: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-ember.css")).toString()
      },
      initialProject
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
  <title>Relay</title>
  <link rel="stylesheet" href="${baseCss}" />
  <link rel="stylesheet" id="theme-css" href="${initialTheme}" />
</head>
<body class="relay-panel">
  <main class="content content--main panel-shell" id="content">
    <section class="panel panel--main">
      <div class="panel__header">
        <div>
          <p class="eyebrow">Project</p>
          <h2 id="main-title">Awaiting project selection</h2>
        </div>
        <div id="main-status" class="status-copy">Choose a project from the Relay sidebar.</div>
      </div>
      <div id="message-banner"></div>
      <div id="build-list" class="build-list empty-state">
        No project selected.
      </div>
    </section>
    <section class="panel panel--detail is-hidden" id="detail-panel">
      <div class="panel__header">
        <div>
          <p class="eyebrow">Build</p>
          <h2 id="detail-title">No build selected</h2>
        </div>
        <button id="close-detail" class="button button--ghost">Close</button>
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
      activeTheme: isThemeId(stored?.activeTheme) ? stored.activeTheme : "neon",
      orgUrl: stored?.orgUrl ?? ""
    };
  }
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
  return value === "neon" || value === "nightwave" || value === "ember";
}
