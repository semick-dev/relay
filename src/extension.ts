import * as fs from "fs/promises";
import * as vscode from "vscode";

import { RelayAdoClient } from "./server/adoClient";
import { RelayApiServer } from "./server/apiServer";
import { RelayCacheStore } from "./server/cacheStore";
import { RelayStorage } from "./server/storage";
import { RelayTelemetrySink } from "./server/telemetry";
import { RelayMainPanel } from "./webview/mainPanel";
import { RelaySidebarProvider } from "./webview/provider";

let relayServer: RelayApiServer | undefined;
const SECRET_KEY = "relay.adoToken";
let relayClient: RelayAdoClient | undefined;
let relayShuttingDown = false;
let latestToken: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const mainPanel = new RelayMainPanel(context);
  const provider = new RelaySidebarProvider(
    context,
    (project, view) => mainPanel.open(project, view),
    (themeId) => mainPanel.postTheme(themeId)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("relay.sidebar", provider),
    vscode.commands.registerCommand("relay.refresh", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.relay");
      vscode.window.showInformationMessage("Use the Refresh Visible Data button inside Relay.");
    }),
    vscode.commands.registerCommand("relay.setToken", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Enter your Azure DevOps Personal Access Token",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "Paste your PAT here"
      });
      if (value === undefined) {
        return;
      }
      if (value) {
        await context.secrets.store(SECRET_KEY, value);
        latestToken = value;
        relayClient?.setToken(value);
      } else {
        await context.secrets.delete(SECRET_KEY);
        latestToken = undefined;
        relayClient?.setToken(undefined);
      }
      provider.notifyAuthChanged();
    }),
    vscode.commands.registerCommand("relay.clearToken", async () => {
      await context.secrets.delete(SECRET_KEY);
      latestToken = undefined;
      relayClient?.setToken(undefined);
      provider.notifyAuthChanged();
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) {
        void context.secrets.get(SECRET_KEY).then((updated) => {
          latestToken = updated || undefined;
          relayClient?.setToken(updated || undefined);
          provider.notifyAuthChanged();
        });
      }
    }),
    provider,
    {
      dispose: () => {
        relayShuttingDown = true;
        if (relayServer) {
          void relayServer.stop();
          relayServer = undefined;
        }
      }
    }
  );

  void initializeRelayRuntime(context, mainPanel, provider);
}

async function initializeRelayRuntime(
  context: vscode.ExtensionContext,
  mainPanel: RelayMainPanel,
  provider: RelaySidebarProvider
): Promise<void> {
  const telemetry = new RelayTelemetrySink();
  try {
    void telemetry.log("relay.activate", "info", {
      extensionMode: context.extensionMode
    });

    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    if (relayShuttingDown) {
      return;
    }

    const storage = new RelayStorage(context.globalStorageUri.fsPath);
    const cacheStore = new RelayCacheStore(storage);
    const secretToken = await context.secrets.get(SECRET_KEY);
    const token = latestToken ?? secretToken ?? undefined;
    const adoClient = new RelayAdoClient(token);
    relayClient = adoClient;

    const server = new RelayApiServer(adoClient, cacheStore, storage, telemetry);
    relayServer = server;

    const port = await server.start();
    if (relayShuttingDown) {
      await server.stop();
      relayServer = undefined;
      return;
    }

    const apiBase = `http://127.0.0.1:${port}`;
    provider.postServerReady(apiBase);
    mainPanel.postServerReady(apiBase);
    await telemetry.log("relay.api.ready", "info", { apiBase });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    provider.postServerError(message);
    mainPanel.postServerError(message);
    await telemetry.log("relay.api.failed", "error", { message });
  }
}

export function deactivate(): Thenable<void> | undefined {
  relayShuttingDown = true;
  relayClient = undefined;
  if (!relayServer) {
    return undefined;
  }

  return relayServer.stop();
}
