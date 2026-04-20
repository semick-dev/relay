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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });

  const telemetry = new RelayTelemetrySink();
  await telemetry.log("relay.activate", "info", {
    extensionMode: context.extensionMode
  });

  const storage = new RelayStorage(context.globalStorageUri.fsPath);
  const cacheStore = new RelayCacheStore(storage);

  const token = await context.secrets.get(SECRET_KEY);

  const adoClient = new RelayAdoClient(token);
  relayServer = new RelayApiServer(adoClient, cacheStore, storage, telemetry);

  const mainPanel = new RelayMainPanel(context);
  const provider = new RelaySidebarProvider(
    context,
    (project, view) => mainPanel.open(project, view),
    (themeId) => mainPanel.postTheme(themeId)
  );

  void startRelayServer(relayServer, mainPanel, provider, telemetry);

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
        adoClient.setToken(value);
      } else {
        await context.secrets.delete(SECRET_KEY);
        adoClient.setToken(undefined);
      }
      provider.notifyAuthChanged();
    }),
    vscode.commands.registerCommand("relay.clearToken", async () => {
      await context.secrets.delete(SECRET_KEY);
      adoClient.setToken(undefined);
      provider.notifyAuthChanged();
    }),
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) {
        void context.secrets.get(SECRET_KEY).then((updated) => {
          adoClient.setToken(updated || undefined);
          provider.notifyAuthChanged();
        });
      }
    }),
    provider,
    {
      dispose: () => {
        if (relayServer) {
          void relayServer.stop();
          relayServer = undefined;
        }
      }
    }
  );
}

async function startRelayServer(
  server: RelayApiServer,
  mainPanel: RelayMainPanel,
  provider: RelaySidebarProvider,
  telemetry: RelayTelemetrySink
): Promise<void> {
  try {
    const port = await server.start();
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
  if (!relayServer) {
    return undefined;
  }

  return relayServer.stop();
}
