import * as vscode from "vscode";
import { PlanEditorProvider } from "./planEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(PlanEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand("pln.openAsText", async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      let uri: vscode.Uri | undefined;

      if (input instanceof vscode.TabInputCustom) {
        uri = input.uri;
      } else if (input instanceof vscode.TabInputText) {
        uri = input.uri;
      } else if (vscode.window.activeTextEditor?.document.languageId === "pln") {
        uri = vscode.window.activeTextEditor.document.uri;
      }

      if (!uri || !uri.path.endsWith(".pln")) {
        vscode.window.showInformationMessage("Open a .pln file first.");
        return;
      }

      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    })
  );
}

export function deactivate(): void {}
