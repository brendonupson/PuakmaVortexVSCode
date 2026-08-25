import * as vscode from "vscode";
import { DataConnection, InventoryItem } from "./tornadoClient";

// TODO: decide whether tornado/ should be git-ignored (a local sync cache)
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
    "tornado",
    folderName(connectionName, app),
  );
  await vscode.workspace.fs.createDirectory(folderUri);
  return folderUri;
}

// Writes each data connection's raw schema dump to DataConnections/{connectionname}.sql
// beneath the app's own tornado/{app} folder — a data connection is specific to
// the app it was fetched alongside, not shared workspace-wide. This is reference
// metadata for local AI tooling to read, not part of the synced application design
// (nothing here is ever uploaded back to the server). The caller is responsible for
// running this inside the same watcher-suppressed block as the rest of the sync, the
// same way it does for devconfig.json, so these writes aren't mistaken for local edits.
export async function writeDataConnections(appFolder: vscode.Uri, dataconnections: DataConnection[]): Promise<void> {
  if (dataconnections.length === 0) {
    return;
  }

  const folderUri = vscode.Uri.joinPath(appFolder, "DataConnections");
  await vscode.workspace.fs.createDirectory(folderUri);

  const encoder = new TextEncoder();
  for (const connection of dataconnections) {
    if (!connection.connectionname || !connection.schema) {
      continue;
    }
    // connectionname is server data used as a filename — guarded the same
    // way ensureDesignElementFolder guards its own path segments above, but
    // skipped rather than thrown: one oddly-named connection shouldn't stop
    // the rest of this best-effort metadata write from landing.
    try {
      assertSafePathSegment(connection.connectionname, "connection name");
    } catch {
      continue;
    }
    const fileUri = vscode.Uri.joinPath(folderUri, `${connection.connectionname}.sql`);
    await vscode.workspace.fs.writeFile(fileUri, encoder.encode(connection.schema));
  }
}

