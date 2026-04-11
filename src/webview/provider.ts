import * as vscode from "vscode";

import { RelayBootstrap, RelayPersistedState, RelaySubview, ThemeId } from "../shared/types";

const STATE_KEY = "relay.uiState";

const DEFAULT_STATE: RelayPersistedState = {
  activeTheme: "neon",
  orgUrl: ""
};

export class RelaySidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly apiBase: string,
    private readonly onOpenProject: (project: string, view: RelaySubview) => void,
    private readonly onThemeChange: (theme: ThemeId) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media")
      ]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    this.disposables.push(webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    }));
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const typed = message as {
      type?: string;
      state?: Partial<RelayPersistedState>;
      project?: string;
      themeId?: ThemeId;
      view?: RelaySubview;
    };
    if (typed.type === "persistState" && typed.state) {
      const current = this.getState();
      const next: RelayPersistedState = {
        activeTheme: isThemeId(typed.state.activeTheme) ? typed.state.activeTheme : current.activeTheme,
        orgUrl: typeof typed.state.orgUrl === "string" ? typed.state.orgUrl : current.orgUrl
      };
      await this.context.globalState.update(STATE_KEY, next);
      return;
    }

    if (
      typed.type === "openProject" &&
      typeof typed.project === "string" &&
      typed.project &&
      isSubview(typed.view)
    ) {
      this.onOpenProject(typed.project, typed.view);
      return;
    }

    if (typed.type === "themeChanged" && isThemeId(typed.themeId)) {
      this.onThemeChange(typed.themeId);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const bootstrap: RelayBootstrap = {
      apiBase: this.apiBase,
      telemetryBase: this.apiBase,
      savedState: this.getState(),
      themeIds: ["neon", "nightwave", "ember"],
      themeUrls: {
        neon: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-neon.css")).toString(),
        nightwave: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-nightwave.css")).toString(),
        ember: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "theme-ember.css")).toString()
      }
    };
    const baseCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "base.css"));
    const initialTheme = bootstrap.themeUrls[bootstrap.savedState.activeTheme];
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
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
<body>
  <div id="app" class="sidebar-shell">
    <aside class="sidebar sidebar--standalone">
      <div class="sidebar__header">
        <p class="eyebrow">Relay</p>
        <h1>ADO Build UI</h1>
        <p class="muted">Cache-heavy. Debugging-forward.</p>
      </div>

      <div class="sidebar__group">
        <label for="org-url">Target ADO URL</label>
        <input id="org-url" type="text" placeholder="https://example.visualstudio.com/" />
        <button id="connect-button" class="button button--primary">Load Projects</button>
      </div>

      <div class="sidebar__group sidebar__group--projects">
        <div class="section-title">
          <span>Projects</span>
          <span id="cache-pill" class="pill">Idle</span>
        </div>
        <div id="project-list" class="project-list"></div>
      </div>

      <div class="theme-picker">
        <p class="section-title">Themes</p>
        <div id="theme-list" class="theme-list"></div>
      </div>
    </aside>

      <div id="message-banner"></div>
    </aside>
  </div>

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
      activeTheme: isThemeId(stored?.activeTheme) ? stored.activeTheme : DEFAULT_STATE.activeTheme,
      orgUrl: stored?.orgUrl ?? DEFAULT_STATE.orgUrl
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

function isSubview(value: unknown): value is RelaySubview {
  return value === "definitions" || value === "builds" || value === "artifacts";
}
