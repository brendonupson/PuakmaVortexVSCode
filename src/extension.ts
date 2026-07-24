import * as vscode from "vscode";
import {
  addConnection,
  getActiveConnection,
  getConnections,
  getCredentials,
  removeConnection,
  setActiveConnectionId,
  updateConnection,
} from "./config";
import { DesignElementPayload, InventoryItem, TornadoClient } from "./tornadoClient";
import { INHERITED_APP_URI_SCHEME, InventoryTreeProvider } from "./inventoryTreeProvider";
import { ensureDesignElementFolder } from "./workspaceStorage";
import { DesignSyncResult, readManifest, writeDesignElements } from "./designSync";
import { AppWatcher } from "./appWatcher";
import { compileApp, ensureServerLibraries } from "./javaCompiler";
import { ensureJavaIntelliSense } from "./javaIntellisense";

async function buildClient(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<TornadoClient | undefined> {
  const connection = getActiveConnection(context);
  if (!connection) {
    output.appendLine("No active Tornado connection.");
    return undefined;
  }
  const credentials = await getCredentials(context, connection.id);
  if (!credentials) {
    output.appendLine(`No stored credentials for connection "${connection.name}".`);
    return undefined;
  }
  return new TornadoClient(connection.serverUrl, credentials.username, credentials.password, output);
}

// Shared by every command that needs a client for a *specific* connection
// (as opposed to buildClient() above, which always uses the active one) —
// watching, syncing, refreshing, and compiling all resolve their client
// this way from a manifest's stored connectionId.
async function buildClientForConnection(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  connectionId: string,
): Promise<{ client: TornadoClient; connectionName: string }> {
  const connection = getConnections().find((c) => c.id === connectionId);
  if (!connection) {
    throw new Error("The Tornado connection this application was synced from no longer exists.");
  }
  const credentials = await getCredentials(context, connection.id);
  if (!credentials) {
    throw new Error(`No stored credentials for connection "${connection.name}".`);
  }
  return {
    client: new TornadoClient(connection.serverUrl, credentials.username, credentials.password, output),
    connectionName: connection.name,
  };
}

async function startWatchingFolder(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  activeWatchers: Map<string, AppWatcher>,
  appFolder: vscode.Uri,
): Promise<AppWatcher> {
  const key = appFolder.toString();
  const existing = activeWatchers.get(key);
  if (existing) {
    return existing;
  }

  const manifest = await readManifest(appFolder);
  if (!manifest) {
    throw new Error(`No synced application found at ${appFolder.fsPath} — sync it first.`);
  }
  const { client } = await buildClientForConnection(context, output, manifest.connectionId);
  const watcher = new AppWatcher(appFolder, manifest.appid, client, output, manifest);
  activeWatchers.set(key, watcher);
  context.subscriptions.push(watcher, {
    dispose: () => activeWatchers.delete(key),
  });
  return watcher;
}

// Shared by "sync this app" (tornado.syncApplication) and "refresh an
// already-synced app from the server" (tornado.refreshFromServer): fetches
// the current design and writes it to disk, suppressing the app's watcher
// (if any) so the rewrite doesn't get echoed straight back as uploads.
async function syncDesignToFolder(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  activeWatchers: Map<string, AppWatcher>,
  appFolder: vscode.Uri,
  appid: number,
  connectionId: string,
): Promise<DesignSyncResult> {
  const { client } = await buildClientForConnection(context, output, connectionId);

  const design = await client.fetchApplicationDesign(appid);
  const existingWatcher = activeWatchers.get(appFolder.toString());
  output.appendLine(`Writing ${design.designelements.length} design element(s) to disk...`);
  const result = existingWatcher
    ? await existingWatcher.runSuppressed(() =>
        writeDesignElements(appFolder, appid, connectionId, design.designelements, output),
      )
    : await writeDesignElements(appFolder, appid, connectionId, design.designelements, output);
  if (existingWatcher) {
    await existingWatcher.reloadManifest();
  }

  // Keep the compile classpath warm from the moment an app is connected —
  // otherwise it only ever gets fetched lazily on first compile, which is
  // easy to mistake for "not being downloaded at all". Non-fatal: a server
  // without these endpoints, or a permissions issue, shouldn't break an
  // otherwise-successful file sync.
  try {
    const tornadoRoot = vscode.Uri.joinPath(appFolder, "..");
    await ensureServerLibraries(tornadoRoot, connectionId, client, output);
    const justConfigured = await ensureJavaIntelliSense(output);
    if (justConfigured) {
      vscode.window.showInformationMessage(
        "Tornado: pointed the Java editor at the server's jars for IntelliSense. If types like " +
          "ActionRunner still show as unresolved, run 'Java: Clean the Java Language Server Workspace' " +
          "or reload the window.",
      );
    }
  } catch (error) {
    output.appendLine(`Could not refresh server libraries: ${(error as Error).message}`);
  }

  return result;
}

export interface CompileAndUploadSummary {
  uploaded: number;
  skipped: number;
  hadErrors: boolean;
  failedSourceNames: string[];
}

// Shared by the tornado.compileAndUpload command and the auto-compile-on-save
// listener registered in activate() below: batch-compiles an app's Java
// sources and uploads whatever compiled successfully — even if javac
// reported errors for other sources in the same batch, so one broken file
// doesn't hold back every other file's save from reaching the server (see
// hadErrors/failedSourceNames on the result). Returns undefined only if
// there was nothing to compile at all (no .java sources found).
async function compileAndUploadFolder(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  folder: vscode.Uri,
): Promise<CompileAndUploadSummary | undefined> {
  const manifest = await readManifest(folder);
  if (!manifest) {
    throw new Error(`No manifest found in ${folder.fsPath}.`);
  }
  const { client } = await buildClientForConnection(context, output, manifest.connectionId);
  const result = await compileApp(folder, manifest.connectionId, client, context.globalStorageUri, output);
  if (!result) {
    return undefined;
  }

  let uploaded = 0;
  let skipped = 0;
  for (const classFileUri of result.classFiles) {
    const fileName = classFileUri.path.split("/").pop() ?? "";
    const className = fileName.replace(/\.class$/, "");
    // Java-source design types only (Actions/SharedCode/ScheduledActions
    // — designtypes 3/4/6); matched by name, same as the reference tool.
    const entry = manifest.elements.find((e) => e.name === className && [3, 4, 6].includes(e.designtype));
    if (!entry) {
      output.appendLine(`Skipping ${fileName}: no matching Java design element in the manifest.`);
      skipped++;
      continue;
    }

    const classBytes = await vscode.workspace.fs.readFile(classFileUri);
    let sourceBase64 = "";
    try {
      const sourceBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, entry.path));
      sourceBase64 = Buffer.from(sourceBytes).toString("base64");
    } catch {
      output.appendLine(`  ${entry.path} not found — uploading compiled class without refreshing source.`);
    }

    const payload: DesignElementPayload = {
      designbucketid: entry.designbucketid,
      appid: manifest.appid,
      name: entry.name,
      designtype: entry.designtype,
      contenttype: entry.contenttype,
      designdata: Buffer.from(classBytes).toString("base64"),
      designsource: sourceBase64,
      inheritfrom: entry.inheritfrom,
      comment: entry.comment,
      options: entry.options,
      designparams: entry.designparams,
    };
    await client.updateDesignElement(manifest.appid, entry.designbucketid, payload);
    output.appendLine(`Uploaded compiled "${entry.name}" (${classBytes.length} bytes).`);
    uploaded++;
  }

  return { uploaded, skipped, hadErrors: result.hadErrors, failedSourceNames: result.failedSourceNames };
}

function formatCompileSummary(result: CompileAndUploadSummary): string {
  const parts = [`uploaded ${result.uploaded} Java design element(s)`];
  if (result.skipped > 0) {
    parts.push(`${result.skipped} skipped (no matching design element)`);
  }
  if (result.failedSourceNames.length > 0) {
    // Rare with ecj's -proceedOnError (it normally still produces a stub
    // class for a broken source) — this means a source produced no output
    // at all, so nothing for it could be uploaded this run.
    parts.push(`produced no output at all, not uploaded: ${result.failedSourceNames.join(", ")}`);
  } else if (result.hadErrors) {
    // The common "had errors" case now: ecj reported errors but still
    // produced (and this uploaded) a stub for the affected source(s) —
    // that stub only throws if the broken part is actually reached.
    parts.push("ecj reported errors — the affected class(es) may throw at runtime if reached, see the Tornado output channel");
  }
  return parts.join("; ");
}

// Shared by tornado.startWatching and tornado.refreshFromServer: lets the
// user pick one of the applications already synced into this workspace.
async function pickSyncedAppFolder(placeHolder: string): Promise<vscode.Uri | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder first.");
    return undefined;
  }
  const manifests = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, ".tornado/*/.tornado-manifest.json"),
  );
  if (manifests.length === 0) {
    vscode.window.showInformationMessage("No synced Tornado applications found in this workspace.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    manifests.map((uri) => {
      const folder = vscode.Uri.joinPath(uri, "..");
      return { label: folder.fsPath.split("/").pop() ?? folder.fsPath, folder };
    }),
    { placeHolder },
  );
  return picked?.folder;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Tornado");
  context.subscriptions.push(output);
  const activeWatchers = new Map<string, AppWatcher>();

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri) {
        if (uri.scheme === INHERITED_APP_URI_SCHEME && uri.query.includes("inherited=1")) {
          return { color: new vscode.ThemeColor("charts.red") };
        }
        return undefined;
      },
    }),
  );

  const treeProvider = new InventoryTreeProvider(undefined, output);
  const treeView = vscode.window.createTreeView("tornadoInventory", {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);
  treeProvider.attachTreeView(treeView);

  function updateTreeViewDescription(): void {
    treeView.description = getActiveConnection(context)?.name;
  }

  // Two separate context keys so the empty-state welcome content in
  // package.json can tell "no connections at all" apart from "connections
  // exist but none is active" — a fetch failure once a connection *is*
  // active is instead surfaced via treeView.message, set in the provider.
  function updateContextKeys(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "tornado.hasConnections",
      getConnections().length > 0,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "tornado.hasActiveConnection",
      getActiveConnection(context) !== undefined,
    );
  }
  updateContextKeys();
  updateTreeViewDescription();
  treeProvider.setClient(await buildClient(context, output));

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.addConnection", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Connection name",
        placeHolder: "e.g. Dev, Staging, Production", 
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      const serverUrl = await vscode.window.showInputBox({
        prompt: "Tornado server URL",
        placeHolder: "https://tornado.example.com/system/webdesign.pma",
        ignoreFocusOut: true,
      });
      if (!serverUrl) {
        return;
      }

      const username = await vscode.window.showInputBox({
        prompt: "Tornado username",
        ignoreFocusOut: true,
      });
      if (username === undefined) {
        return;
      }

      const password = await vscode.window.showInputBox({
        prompt: "Tornado password",
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) {
        return;
      }

      try {
        await addConnection(context, name, serverUrl, { username, password });
        treeProvider.setClient(await buildClient(context, output));
        updateTreeViewDescription();
        updateContextKeys();
        vscode.window.showInformationMessage(`Tornado connection "${name}" added and selected.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to add Tornado connection: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.selectConnection", async () => {
      const connections = getConnections();
      if (connections.length === 0) {
        vscode.window.showInformationMessage(
          "No Tornado connections configured yet. Run 'Tornado: Add Connection' first.",
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        connections.map((connection) => ({
          label: connection.name,
          description: connection.serverUrl,
          id: connection.id,
        })),
        { placeHolder: "Select the active Tornado connection" },
      );
      if (!picked) {
        return;
      }

      try {
        await setActiveConnectionId(context, picked.id);
        treeProvider.setClient(await buildClient(context, output));
        updateTreeViewDescription();
        updateContextKeys();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to select Tornado connection: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.editConnection", async () => {
      const connections = getConnections();
      if (connections.length === 0) {
        vscode.window.showInformationMessage("No Tornado connections configured.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        connections.map((connection) => ({
          label: connection.name,
          description: connection.serverUrl,
          id: connection.id,
        })),
        { placeHolder: "Select a connection to edit" },
      );
      if (!picked) {
        return;
      }
      const connection = connections.find((c) => c.id === picked.id);
      if (!connection) {
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: "Connection name",
        value: connection.name,
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      const serverUrl = await vscode.window.showInputBox({
        prompt: "Tornado server URL",
        value: connection.serverUrl,
        ignoreFocusOut: true,
      });
      if (!serverUrl) {
        return;
      }

      const existingCredentials = await getCredentials(context, connection.id);
      const username = await vscode.window.showInputBox({
        prompt: "Tornado username",
        value: existingCredentials?.username ?? "",
        ignoreFocusOut: true,
      });
      if (username === undefined) {
        return;
      }

      const password = await vscode.window.showInputBox({
        prompt: "Tornado password (leave blank to keep the current password)",
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) {
        return;
      }
      const finalPassword = password || existingCredentials?.password;
      if (!finalPassword) {
        vscode.window.showErrorMessage("A password is required.");
        return;
      }

      try {
        await updateConnection(context, connection.id, name, serverUrl, {
          username,
          password: finalPassword,
        });
        treeProvider.setClient(await buildClient(context, output));
        updateTreeViewDescription();
        vscode.window.showInformationMessage(`Tornado connection "${name}" updated.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to edit Tornado connection: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.deleteConnection", async () => {
      const connections = getConnections();
      if (connections.length === 0) {
        vscode.window.showInformationMessage("No Tornado connections configured.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        connections.map((connection) => ({
          label: connection.name,
          description: connection.serverUrl,
          id: connection.id,
        })),
        { placeHolder: "Select a connection to delete" },
      );
      if (!picked) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete connection "${picked.label}"? This also deletes its stored credentials.`,
        { modal: true },
        "Delete",
      );
      if (confirmed !== "Delete") {
        return;
      }

      try {
        await removeConnection(context, picked.id);
        treeProvider.setClient(await buildClient(context, output));
        updateTreeViewDescription();
        updateContextKeys();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to delete Tornado connection: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.refreshInventory", async () => {
      try {
        treeProvider.setClient(await buildClient(context, output));
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to refresh Tornado inventory: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tornado.syncApplication",
      async (selected?: InventoryItem) => {
        const connection = getActiveConnection(context);
        if (!connection) {
          vscode.window.showErrorMessage(
            "No active Tornado connection. Run 'Tornado: Add Connection' or 'Tornado: Select Connection' first.",
          );
          return;
        }

        // Clicking an app in the Inventory tree passes it (with its appid)
        // directly; invoking via the Command Palette falls back to asking
        // for the app name, with no group and no appid — downloading needs
        // the appid, so that case can only create the local folder.
        let app: (Pick<InventoryItem, "appgroup" | "appname"> & { appid?: number }) | undefined =
          selected;
        if (!app) {
          const appname = await vscode.window.showInputBox({
            prompt: "Application name to sync",
            ignoreFocusOut: true,
          });
          if (!appname) {
            return;
          }
          app = { appgroup: "", appname, appid: undefined };
        }

        if (!vscode.workspace.workspaceFolders?.length) {
          const openFolder = "Open Folder...";
          const choice = await vscode.window.showErrorMessage(
            "Open a workspace folder before syncing a Tornado application.",
            openFolder,
          );
          if (choice === openFolder) {
            // Opening a folder reloads the window, so the sync itself has
            // to be retried afterwards rather than resuming automatically.
            await vscode.commands.executeCommand("vscode.openFolder");
          }
          return;
        }

        try {
          const folder = await ensureDesignElementFolder(connection.name, app);
          output.appendLine(`Syncing "${app.appname}" into ${folder.fsPath}`);
          if (app.appid === undefined) {
            output.appendLine("No app id available (opened via Command Palette) — folder created, nothing to download.");
            vscode.window.showWarningMessage(
              `Created ${folder.fsPath}. Select the app from the Inventory tree to download its design (requires its app id).`,
            );
            return;
          }

          const wasWatching = activeWatchers.has(folder.toString());
          const result = await syncDesignToFolder(
            context,
            output,
            activeWatchers,
            folder,
            app.appid,
            connection.id,
          );

          if (wasWatching) {
            vscode.window.showInformationMessage(
              `Synced ${result.written} design element(s) to ${folder.fsPath}`,
            );
          } else {
            const startWatchingAction = "Start Watching";
            const choice = await vscode.window.showInformationMessage(
              `Synced ${result.written} design element(s) to ${folder.fsPath}`,
              startWatchingAction,
            );
            if (choice === startWatchingAction) {
              await startWatchingFolder(context, output, activeWatchers, folder);
              vscode.window.showInformationMessage(`Watching ${folder.fsPath} for local changes.`);
            }
          }
        } catch (error) {
          output.appendLine(`Sync failed: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.startWatching", async () => {
      const folder = await pickSyncedAppFolder("Select a synced application to watch");
      if (!folder) {
        return;
      }
      try {
        await startWatchingFolder(context, output, activeWatchers, folder);
        vscode.window.showInformationMessage(`Watching ${folder.fsPath} for local changes.`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start watching: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.refreshFromServer", async () => {
      const folder = await pickSyncedAppFolder("Select an application to refresh from the server");
      if (!folder) {
        return;
      }

      const manifest = await readManifest(folder);
      if (!manifest) {
        vscode.window.showErrorMessage(`No manifest found in ${folder.fsPath}.`);
        return;
      }

      const refreshAction = "Refresh";
      const confirmed = await vscode.window.showWarningMessage(
        `Refresh "${folder.fsPath.split("/").pop()}" from the Tornado server? ` +
          "This overwrites local files with the server's current design.",
        { modal: true },
        refreshAction,
      );
      if (confirmed !== refreshAction) {
        return;
      }

      try {
        const result = await syncDesignToFolder(
          context,
          output,
          activeWatchers,
          folder,
          manifest.appid,
          manifest.connectionId,
        );
        vscode.window.showInformationMessage(
          `Refreshed ${result.written} design element(s) in ${folder.fsPath}`,
        );
      } catch (error) {
        output.appendLine(`Refresh failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.stopWatching", async () => {
      if (activeWatchers.size === 0) {
        vscode.window.showInformationMessage("No Tornado applications are currently being watched.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        [...activeWatchers.keys()].map((key) => ({
          label: vscode.Uri.parse(key).fsPath,
          key,
        })),
        { placeHolder: "Select a watched application to stop" },
      );
      if (!picked) {
        return;
      }

      activeWatchers.get(picked.key)?.dispose();
      activeWatchers.delete(picked.key);
      vscode.window.showInformationMessage(`Stopped watching ${picked.label}.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.compileAndUpload", async () => {
      const folder = await pickSyncedAppFolder("Select an application to compile and upload");
      if (!folder) {
        return;
      }
      try {
        const result = await compileAndUploadFolder(context, output, folder);
        if (!result) {
          vscode.window.showInformationMessage("No .java sources found to compile.");
          return;
        }
        const message = `Tornado compile: ${formatCompileSummary(result)}`;
        if (result.hadErrors) {
          vscode.window.showWarningMessage(message);
        } else {
          vscode.window.showInformationMessage(message);
        }
      } catch (error) {
        output.appendLine(`Compile & upload failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tornado.refreshServerLibraries", async () => {
      const folder = await pickSyncedAppFolder("Select an application to refresh server libraries for");
      if (!folder) {
        return;
      }
      const manifest = await readManifest(folder);
      if (!manifest) {
        vscode.window.showErrorMessage(`No manifest found in ${folder.fsPath}.`);
        return;
      }

      try {
        const { client, connectionName } = await buildClientForConnection(
          context,
          output,
          manifest.connectionId,
        );
        const tornadoRoot = vscode.Uri.joinPath(folder, "..");
        await ensureServerLibraries(tornadoRoot, manifest.connectionId, client, output, true);
        await ensureJavaIntelliSense(output);
        vscode.window.showInformationMessage(`Refreshed server libraries for "${connectionName}".`);
      } catch (error) {
        output.appendLine(`Refreshing server libraries failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  // Auto-compile-on-save: saving a .java file always recompiles and
  // re-uploads the *whole* app's Java, not just the saved file — Actions,
  // SharedCode, and ScheduledActions can reference each other, so compiling
  // one file in isolation could fail (or silently miss cross-file changes)
  // in a way a single-file compile can't detect. Only fires for apps that
  // are currently watched, matching how every other file type already only
  // auto-uploads while watching. Debounced per app folder so saving several
  // files in quick succession (e.g. Save All) triggers one compile, not one
  // per file; a still-running compile for that folder is skipped rather
  // than overlapped with a second javac invocation into the same zbin/.
  const compileDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  const compilingFolders = new Set<string>();
  const JAVA_SOURCE_FOLDERS = ["Actions", "SharedCode", "ScheduledActions"];

  async function runAutoCompile(folder: vscode.Uri, savedRelativePath: string): Promise<void> {
    const key = folder.toString();
    if (compilingFolders.has(key)) {
      output.appendLine(`Skipped auto-compile for ${folder.fsPath}: a compile is already in progress.`);
      return;
    }
    compilingFolders.add(key);
    output.appendLine(`Auto-compiling ${folder.fsPath} after saving "${savedRelativePath}"...`);
    try {
      const result = await compileAndUploadFolder(context, output, folder);
      if (result) {
        output.appendLine(`Auto-compile: ${formatCompileSummary(result)}.`);
        // Only pop a toast for sources that produced no output at all —
        // ecj reporting errors but still uploading a stub (the common
        // case now, see formatCompileSummary) is routine with
        // -proceedOnError and would make every save with a lingering
        // error noisy, defeating the point of "keep working despite
        // errors".
        if (result.failedSourceNames.length > 0) {
          vscode.window.showWarningMessage(
            `Tornado auto-compile: ${result.uploaded} uploaded, but ` +
              `${result.failedSourceNames.join(", ")} produced no output at all — see the Tornado output channel.`,
          );
        }
      }
    } catch (error) {
      output.appendLine(`Auto-compile failed: ${(error as Error).message}`);
      output.show(true);
      vscode.window.showErrorMessage(`Tornado auto-compile failed: ${(error as Error).message}`);
    } finally {
      compilingFolders.delete(key);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!document.fileName.endsWith(".java")) {
        return;
      }
      if (!vscode.workspace.getConfiguration("tornado").get<boolean>("compileOnSave", true)) {
        return;
      }
      for (const watcher of activeWatchers.values()) {
        const base = watcher.appFolder.path.endsWith("/")
          ? watcher.appFolder.path
          : `${watcher.appFolder.path}/`;
        if (!document.uri.path.startsWith(base)) {
          continue;
        }
        const relative = document.uri.path.slice(base.length);
        const [typeFolder] = relative.split("/");
        if (!JAVA_SOURCE_FOLDERS.includes(typeFolder)) {
          continue;
        }

        const key = watcher.appFolder.toString();
        const existingTimer = compileDebounce.get(key);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        compileDebounce.set(
          key,
          setTimeout(() => {
            compileDebounce.delete(key);
            void runAutoCompile(watcher.appFolder, relative);
          }, 400),
        );
        return;
      }
    }),
  );
}

export function deactivate(): void {}
