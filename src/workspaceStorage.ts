import * as vscode from "vscode";
import { InventoryItem } from "./tornadoClient";

// TODO: decide whether .tornado/ should be git-ignored (a local sync cache)
// or committed (the source of truth for the application's design elements).
// Left unresolved for now — not added to .gitignore.

// connectionName/appgroup/appname (and, in designSync.ts, design element
// names) come from server data or user input and get used as path
// segments, so guard against any of them injecting a path separator.
export function assertSafePathSegment(segment: string, label: string): void {
  if (!segment || segment === "." || segment === ".." || /[/\\]/.test(segment)) {
    throw new Error(`Invalid ${label} "${segment}": cannot be used as a folder name.`);
  }
}

export function folderName(connectionName: string, app: Pick<InventoryItem, "appgroup" | "appname">): string {
  // appgroup is optional (can be ""), so it's dropped rather than leaving a
  // stray double underscore.
  return [connectionName, app.appgroup, app.appname].filter((part) => part.length > 0).join("_");
}

export async function ensureDesignElementFolder(
  connectionName: string,
  app: Pick<InventoryItem, "appgroup" | "appname">,
): Promise<vscode.Uri> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("Open a workspace folder before syncing a Tornado application.");
  }

  assertSafePathSegment(connectionName, "connection name");
  assertSafePathSegment(app.appname, "app name");
  if (app.appgroup) {
    assertSafePathSegment(app.appgroup, "app group");
  }

  const folderUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    ".tornado",
    folderName(connectionName, app),
  );
  await vscode.workspace.fs.createDirectory(folderUri);
  return folderUri;
}

