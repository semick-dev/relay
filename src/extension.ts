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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });

  const telemetry = new RelayTelemetrySink();
  await telemetry.log("relay.activate", "info", {
    extensionMode: context.extensionMode
  });

  const storage = new RelayStorage(context.globalStorageUri.fsPath);
  const cacheStore = new RelayCacheStore(storage);
  const adoClient = new RelayAdoClient(process.env.ADO_TOKEN);
  relayServer = new RelayApiServer(adoClient, cacheStore, storage, telemetry);

  const port = await relayServer.start();
  const apiBase = `http://127.0.0.1:${port}`;
  const mainPanel = new RelayMainPanel(context, apiBase);
  const provider = new RelaySidebarProvider(
    context,
    apiBase,
    (project) => mainPanel.open(project),
    (themeId) => mainPanel.postTheme(themeId)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("relay.sidebar", provider),
    vscode.commands.registerCommand("relay.refresh", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.relay");
      vscode.window.showInformationMessage("Use the Refresh Visible Data button inside Relay.");
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

export function deactivate(): Thenable<void> | undefined {
  if (!relayServer) {
    return undefined;
  }

  return relayServer.stop();
}
