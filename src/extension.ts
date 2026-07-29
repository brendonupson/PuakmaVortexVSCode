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
import {
  DesignElementPayload,
  NewApplicationPayload,
  NewDesignElementPayload,
  InventoryItem,
  TornadoClient,
} from "./tornadoClient";
import { INHERITED_APP_URI_SCHEME, InventoryTreeProvider } from "./inventoryTreeProvider";
import { assertSafePathSegment, ensureDesignElementFolder, folderName } from "./workspaceStorage";
import {
  DesignSyncResult,
  DEV_CONFIG_RELATIVE_PATH,
  Manifest,
  ManifestEntry,
  extensionFor,
  inferContentType,
  isNestedJavaClassName,
  readManifest,
  useSourceField,
  writeDesignElements,
  writeManifestFile,
} from "./designSync";
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
    await ensureServerLibraries(tornadoRoot, appFolder, connectionId, client, output);
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

  // Nested/inner/anonymous classes (e.g. Foo$Bar.class) have no .java of
  // their own to match a manifest entry by name — they're deployed as
  // SharedCode (designtype 4), created on the server the first time each
  // one is seen and updated in place on every compile after that.
  let manifestChanged = false;
  for (const classFileUri of result.nestedClassFiles) {
    const fileName = classFileUri.path.split("/").pop() ?? "";
    const className = fileName.replace(/\.class$/, "");
    const classBytes = await vscode.workspace.fs.readFile(classFileUri);
    const designdata = Buffer.from(classBytes).toString("base64");

    const entry = manifest.elements.find((e) => e.name === className && e.designtype === 4);
    if (entry) {
      const payload: DesignElementPayload = {
        designbucketid: entry.designbucketid,
        appid: manifest.appid,
        name: entry.name,
        designtype: entry.designtype,
        contenttype: entry.contenttype,
        designdata,
        designsource: "",
        inheritfrom: entry.inheritfrom,
        comment: entry.comment,
        options: entry.options,
        designparams: entry.designparams,
      };
      await client.updateDesignElement(manifest.appid, entry.designbucketid, payload);
      output.appendLine(`Uploaded compiled nested class "${className}" (${classBytes.length} bytes).`);
      uploaded++;
      continue;
    }

    const contenttype = inferContentType(4, ".java");
    const newPayload: NewDesignElementPayload = {
      appid: manifest.appid,
      name: className,
      designtype: 4,
      contenttype,
      designdata,
      designsource: "",
      inheritfrom: null,
      comment: "",
      options: "",
      designparams: [],
    };
    const created = await client.createDesignElement(manifest.appid, newPayload);
    manifest.elements.push({
      path: `SharedCode/${created.name}.class`,
      designbucketid: created.designbucketid,
      name: created.name,
      designtype: created.designtype,
      contenttype: created.contenttype,
      inheritfrom: created.inheritfrom,
      comment: created.comment,
      options: created.options,
      designparams: created.designparams,
    });
    manifestChanged = true;
    output.appendLine(
      `Created nested class "${className}" as a new SharedCode design element (id ${created.designbucketid}).`,
    );
    uploaded++;
  }
  if (manifestChanged) {
    await writeManifestFile(folder, manifest);
  }

  return { uploaded, skipped, hadErrors: result.hadErrors, failedSourceNames: result.failedSourceNames };
}

// "/appgroup/appname" (appgroup dropped when empty, i.e. ungrouped) — used
// wherever an app is named in UI text, so an app is distinguishable from a
// same-named app in a different group.
function appPathLabel(app: Pick<InventoryItem, "appgroup" | "appname">): string {
  return `/${[app.appgroup, app.appname].filter((part) => part.length > 0).join("/")}`;
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

interface EditableFieldDef<K extends string> {
  key: K;
  label: string;
  prompt: string;
}

interface PropertyQuickPickItem<K extends string> extends vscode.QuickPickItem {
  action: "edit" | "save" | "cancel";
  field?: K;
}

// Shared by tornado.editDesignElementProperties and
// tornado.editApplicationProperties: a QuickPick listing each editable
// string field alongside its current value, letting the user open an input
// box for one field at a time and loop back until Save or Cancel. Returns
// only the fields actually changed, or undefined if cancelled without
// saving (including a plain Escape out of the QuickPick itself).
async function editPropertiesViaQuickPick<K extends string>(
  title: string,
  fields: EditableFieldDef<K>[],
  currentValueOf: (key: K) => string,
): Promise<Partial<Record<K, string>> | undefined> {
  const edits: Partial<Record<K, string>> = {};
  const valueOf = (key: K): string => edits[key] ?? currentValueOf(key);

  while (true) {
    const items: PropertyQuickPickItem<K>[] = [
      ...fields.map((field) => ({
        label: field.label,
        description: valueOf(field.key) || "(empty)",
        action: "edit" as const,
        field: field.key,
      })),
      { label: "$(check) Save Changes", action: "save" as const },
      { label: "$(x) Cancel Without Saving", action: "cancel" as const },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: "Select a property to edit",
      ignoreFocusOut: true,
    });
    if (!picked || picked.action === "cancel") {
      return undefined;
    }
    if (picked.action === "save") {
      return edits;
    }
    const field = fields.find((f) => f.key === picked.field)!;
    const newValue = await vscode.window.showInputBox({
      prompt: field.prompt,
      value: valueOf(field.key),
      ignoreFocusOut: true,
    });
    if (newValue === undefined) {
      continue;
    }
    edits[field.key] = newValue;
  }
}

// Shared by tornado.createApplication and tornado.editApplicationProperties
// — appdisplayname/appversion are deliberately excluded (read-only,
// server/tooling-managed rather than something meant to be hand-edited here).
type ApplicationPropertyField = "appname" | "appgroup" | "description" | "templatename" | "inheritfrom";
const APPLICATION_PROPERTY_FIELDS: EditableFieldDef<ApplicationPropertyField>[] = [
  { key: "appname", label: "App Name", prompt: "Application name" },
  { key: "appgroup", label: "App Group", prompt: "Application group, or leave empty for none" },
  { key: "description", label: "Description", prompt: "Description" },
  {
    key: "templatename",
    label: "Template Name",
    prompt: "Template name, or leave empty if this application isn't a template",
  },
  {
    key: "inheritfrom",
    label: "Inherit From",
    prompt: "Name of the application to inherit from, or leave empty for none",
  },
];

// Shared by tornado.startWatching and tornado.refreshFromServer: lets the
// user pick one of the applications already synced into this workspace.
async function pickSyncedAppFolder(placeHolder: string): Promise<vscode.Uri | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder first.");
    return undefined;
  }
  const manifests = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, "tornado/*/.tornado-manifest.json"),
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

// Given a file open in the editor (or right-clicked in the Explorer), walks
// up its ancestors looking for a synced app's manifest — a design element's
// path is always exactly two levels under its app folder (<DesignTypeFolder>/
// <file>), but walking rather than hardcoding that depth means this keeps
// working if that ever changes. devconfig.json lives inside Documentation/
// like a real design element but is dev tooling, not one — see designSync.ts
// — so it's explicitly excluded rather than "found" with no matching entry.
async function locateManifestEntry(
  uri: vscode.Uri,
): Promise<{ appFolder: vscode.Uri; manifest: Manifest; entry: ManifestEntry } | undefined> {
  let dir = vscode.Uri.joinPath(uri, "..");
  for (let i = 0; i < 8; i++) {
    const manifest = await readManifest(dir);
    if (manifest) {
      const base = dir.path.endsWith("/") ? dir.path : `${dir.path}/`;
      if (!uri.path.startsWith(base)) {
        return undefined;
      }
      const relativePath = uri.path.slice(base.length);
      if (relativePath === DEV_CONFIG_RELATIVE_PATH) {
        return undefined;
      }
      const entry = manifest.elements.find((e) => e.path === relativePath);
      return entry ? { appFolder: dir, manifest, entry } : undefined;
    }
    const parent = vscode.Uri.joinPath(dir, "..");
    if (parent.path === dir.path) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
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
          const appid = app.appid;
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Syncing "${appPathLabel(app)}"...`,
            },
            () => syncDesignToFolder(context, output, activeWatchers, folder, appid, connection.id),
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
    vscode.commands.registerCommand("tornado.createApplication", async () => {
      const connection = getActiveConnection(context);
      if (!connection) {
        vscode.window.showErrorMessage(
          "No active Tornado connection. Run 'Tornado: Add Connection' or 'Tornado: Select Connection' first.",
        );
        return;
      }
      if (!vscode.workspace.workspaceFolders?.length) {
        const openFolder = "Open Folder...";
        const choice = await vscode.window.showErrorMessage(
          "Open a workspace folder before creating a Tornado application.",
          openFolder,
        );
        if (choice === openFolder) {
          await vscode.commands.executeCommand("vscode.openFolder");
        }
        return;
      }

      const edits = await editPropertiesViaQuickPick(
        "Create Application",
        APPLICATION_PROPERTY_FIELDS,
        () => "",
      );
      if (!edits) {
        return;
      }

      const appname = (edits.appname ?? "").trim();
      const appgroup = (edits.appgroup ?? "").trim();
      try {
        // Same guard ensureDesignElementFolder applies on sync — appname/
        // appgroup double as local folder-name segments (see folderName()
        // in workspaceStorage.ts).
        assertSafePathSegment(appname, "app name");
        if (appgroup) {
          assertSafePathSegment(appgroup, "app group");
        }
      } catch (error) {
        vscode.window.showErrorMessage((error as Error).message);
        return;
      }

      const payload: NewApplicationPayload = {
        appname,
        appdisplayname: "",
        appgroup,
        description: edits.description ?? "",
        templatename: edits.templatename ?? "",
        appversion: "",
        inheritfrom: edits.inheritfrom ?? "",
      };

      let created: InventoryItem;
      try {
        const { client } = await buildClientForConnection(context, output, connection.id);
        created = await client.createApplication(payload);
      } catch (error) {
        output.appendLine(`Failed to create application: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
        return;
      }

      // The application now exists on the server no matter what happens
      // below — refresh the tree and never again report failure as "Failed
      // to create application" past this point, or a user who sees that
      // message (e.g. from the sync leg failing) could reasonably re-run
      // this command and create a duplicate.
      output.appendLine(`Created application "${created.appname}" (id ${created.appid}) on the server.`);
      treeProvider.refresh();

      try {
        const folder = await ensureDesignElementFolder(connection.name, created);
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Syncing "${appPathLabel(created)}"...`,
          },
          () => syncDesignToFolder(context, output, activeWatchers, folder, created.appid, connection.id),
        );

        const startWatchingAction = "Start Watching";
        const choice = await vscode.window.showInformationMessage(
          `Created "${created.appname}" on the Tornado server and synced ${result.written} design ` +
            `element(s) to ${folder.fsPath}`,
          startWatchingAction,
        );
        if (choice === startWatchingAction) {
          await startWatchingFolder(context, output, activeWatchers, folder);
          vscode.window.showInformationMessage(`Watching ${folder.fsPath} for local changes.`);
        }
      } catch (error) {
        output.appendLine(`Local sync of the new application failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showWarningMessage(
          `Created "${created.appname}" (id ${created.appid}) on the Tornado server, but syncing it ` +
            `locally failed: ${(error as Error).message} — select it in the Inventory tree to sync it. ` +
            "Do not re-run Create Application for it.",
        );
      }
    }),
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
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Refreshing "${folder.fsPath.split("/").pop()}"...`,
          },
          () => syncDesignToFolder(context, output, activeWatchers, folder, manifest.appid, manifest.connectionId),
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
        await ensureServerLibraries(tornadoRoot, folder, manifest.connectionId, client, output, true);
        await ensureJavaIntelliSense(output);
        vscode.window.showInformationMessage(`Refreshed server libraries for "${connectionName}".`);
      } catch (error) {
        output.appendLine(`Refreshing server libraries failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tornado.editDesignElementProperties",
      async (uri?: vscode.Uri) => {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
          vscode.window.showErrorMessage("Open or right-click a synced design element file first.");
          return;
        }

        const located = await locateManifestEntry(targetUri);
        if (!located) {
          vscode.window.showErrorMessage(`"${targetUri.fsPath}" isn't a tracked Tornado design element.`);
          return;
        }
        const { appFolder, manifest, entry } = located;

        type EditableField = "name" | "comment" | "options" | "inheritfrom";
        const fields: EditableFieldDef<EditableField>[] = [
          { key: "name", label: "Name", prompt: "Design element name" },
          { key: "comment", label: "Comment", prompt: "Comment" },
          { key: "options", label: "Options", prompt: "Options" },
          {
            key: "inheritfrom",
            label: "Inherit From",
            prompt: "Name of the design element to inherit from, or leave empty for none",
          },
        ];
        const edits = await editPropertiesViaQuickPick(`Edit properties of "${entry.name}"`, fields, (key) =>
          key === "inheritfrom" ? entry.inheritfrom ?? "" : entry[key],
        );
        if (!edits || Object.keys(edits).length === 0) {
          return;
        }

        const oldName = entry.name;
        const oldPath = entry.path;
        const newName = (edits.name ?? oldName).trim();
        try {
          assertSafePathSegment(newName, "design element name");
        } catch (error) {
          vscode.window.showErrorMessage((error as Error).message);
          return;
        }
        if (
          newName !== oldName &&
          manifest.elements.some((e) => e !== entry && e.designtype === entry.designtype && e.name === newName)
        ) {
          vscode.window.showErrorMessage(
            `Another design element named "${newName}" already exists in this application.`,
          );
          return;
        }
        // A nested/inner/anonymous class's name is fixed by its enclosing
        // top-level class (compileAndUploadFolder recreates it under that
        // exact name on every compile) — renaming it here would just leave
        // the renamed copy orphaned on the server once "Compile & Upload
        // Java" recreates "Foo$Bar" from scratch.
        if (newName !== oldName && isNestedJavaClassName(entry.designtype, oldName)) {
          vscode.window.showErrorMessage(
            `"${oldName}" is a nested/inner/anonymous class — its name is fixed by its enclosing ` +
              "class and can't be changed here.",
          );
          return;
        }

        const newComment = edits.comment ?? entry.comment;
        const newOptions = edits.options ?? entry.options;
        const newInheritFrom =
          edits.inheritfrom !== undefined ? edits.inheritfrom.trim() || null : entry.inheritfrom;

        try {
          const { client } = await buildClientForConnection(context, output, manifest.connectionId);
          // Only name/comment/options/inheritfrom are meant to change here —
          // designdata/designsource/contenttype/designparams are re-sent
          // exactly as the server currently has them, fetched fresh rather
          // than reconstructed from the local file: for Java design types
          // the on-disk file is source text, not designdata's compiled
          // bytecode, so guessing content from local bytes risks
          // clobbering it.
          const design = await client.fetchApplicationDesign(manifest.appid);
          const current = design.designelements.find((e) => e.designbucketid === entry.designbucketid);
          if (!current) {
            throw new Error(
              `"${oldName}" (id ${entry.designbucketid}) no longer exists on the server — refresh the application.`,
            );
          }

          const payload: DesignElementPayload = {
            designbucketid: current.designbucketid,
            appid: current.appid,
            name: newName,
            designtype: current.designtype,
            contenttype: current.contenttype,
            designdata: current.designdata,
            designsource: current.designsource,
            inheritfrom: newInheritFrom,
            comment: newComment,
            options: newOptions,
            designparams: current.designparams,
          };
          // Renaming an element by sending a changed "name" in the PUT
          // body is assumed to actually rename it server-side, not just be
          // ignored — every other caller of updateDesignElement always
          // re-sends the existing name unchanged, so this is unverified
          // against a real request (same caveat as createDesignElement's
          // response-shape assumption in tornadoClient.ts). If the server
          // treats "name" as immutable on PUT, this call silently
          // succeeds while not actually renaming anything server-side,
          // and the local rename below would then desync from it.
          await client.updateDesignElement(manifest.appid, entry.designbucketid, payload);

          entry.name = newName;
          entry.comment = newComment;
          entry.options = newOptions;
          entry.inheritfrom = newInheritFrom;

          const existingWatcher = activeWatchers.get(appFolder.toString());
          if (newName !== oldName) {
            // Same computation writeDesignElements uses for the download
            // direction (folder + name + extensionFor, or ".class" for a
            // nested Java class) — keeps the local filename in sync with
            // what the next refresh-from-server would produce anyway.
            const folderPart = oldPath.slice(0, oldPath.lastIndexOf("/"));
            const nestedClass = isNestedJavaClassName(entry.designtype, newName);
            const newFileName = nestedClass
              ? `${newName}.class`
              : `${newName}${extensionFor(entry.designtype, entry.contenttype)}`;
            const newPath = `${folderPart}/${newFileName}`;
            entry.path = newPath;

            const oldUri = vscode.Uri.joinPath(appFolder, oldPath);
            const newUri = vscode.Uri.joinPath(appFolder, newPath);
            const renameEdit = new vscode.WorkspaceEdit();
            renameEdit.renameFile(oldUri, newUri, { overwrite: false });
            // Goes through a WorkspaceEdit rather than workspace.fs.rename
            // so any editor with the old file open follows the rename —
            // and is suppressed on the app's watcher (if running) so the
            // underlying delete+create filesystem events it fires aren't
            // mistaken for a real local delete followed by a new file.
            const renamed = existingWatcher
              ? await existingWatcher.runSuppressed(() => Promise.resolve(vscode.workspace.applyEdit(renameEdit)))
              : await vscode.workspace.applyEdit(renameEdit);
            if (!renamed) {
              throw new Error(
                `Renamed "${oldName}" to "${newName}" on the server, but failed to rename the local ` +
                  `file from "${oldPath}" to "${newPath}" (target may already exist). Run "Tornado: ` +
                  'Refresh from Server" to bring the local copy back in sync with the new name.',
              );
            }
          }

          await writeManifestFile(appFolder, manifest);
          if (existingWatcher) {
            await existingWatcher.reloadManifest();
          }

          output.appendLine(`Updated properties of "${newName}" (id ${entry.designbucketid}).`);
          if (
            newName !== oldName &&
            [3, 4, 6].includes(entry.designtype) &&
            useSourceField(entry.designtype, entry.contenttype)
          ) {
            // The compiler (not the server) is what actually ties a Java
            // design element to its class name — javac/ecj requires a
            // public top-level class's declaration to match its file name,
            // so renaming only the design element leaves the source out of
            // sync until it's edited to match too. useSourceField excludes
            // .jar files, which also live under designtype 4 (SharedCode)
            // but have no "public class" declaration to update.
            vscode.window.showWarningMessage(
              `Renamed "${oldName}" to "${newName}" on the Tornado server. Update the "public class ` +
                `${oldName}" declaration inside the file to "${newName}" too, or the next compile will fail.`,
            );
          } else {
            vscode.window.showInformationMessage(`Updated "${newName}" on the Tornado server.`);
          }
        } catch (error) {
          output.appendLine(`Failed to update design element properties: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tornado.editApplicationProperties",
      async (uri?: vscode.Uri) => {
        const folder = uri ?? (await pickSyncedAppFolder("Select an application to edit properties for"));
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
          // No per-app GET endpoint exists — the inventory listing is the
          // only place an application's current properties can be read
          // from, so this fetches all of them just to find the one match.
          const items = await client.fetchInventory();
          const current = items.find((item) => item.appid === manifest.appid);
          if (!current) {
            vscode.window.showErrorMessage(
              `Application id ${manifest.appid} was not found in the server's inventory — it may have been deleted.`,
            );
            return;
          }

          const edits = await editPropertiesViaQuickPick(
            `Edit properties of "${current.appdisplayname || current.appname}"`,
            APPLICATION_PROPERTY_FIELDS,
            (key) => current[key] ?? "",
          );
          if (!edits || Object.keys(edits).length === 0) {
            return;
          }

          const oldAppName = current.appname;
          const oldAppGroup = current.appgroup;
          const newAppName = (edits.appname ?? oldAppName).trim();
          const newAppGroup = (edits.appgroup ?? oldAppGroup).trim();
          // appname/appgroup double as local folder-name segments (see
          // folderName() in workspaceStorage.ts) — guarded the same way
          // ensureDesignElementFolder already guards them on sync.
          assertSafePathSegment(newAppName, "app name");
          if (newAppGroup) {
            assertSafePathSegment(newAppGroup, "app group");
          }

          const payload: InventoryItem = {
            appid: current.appid,
            appname: newAppName,
            appdisplayname: current.appdisplayname,
            appgroup: newAppGroup,
            description: edits.description ?? current.description,
            templatename: edits.templatename ?? current.templatename,
            appversion: current.appversion,
            inheritfrom: edits.inheritfrom ?? current.inheritfrom,
          };
          await client.updateApplication(current.appid, payload);

          let finalFolder = folder;
          if (newAppName !== oldAppName || newAppGroup !== oldAppGroup) {
            const key = folder.toString();
            const wasWatching = activeWatchers.has(key);
            if (wasWatching) {
              activeWatchers.get(key)?.dispose();
              activeWatchers.delete(key);
            }

            const newFolder = vscode.Uri.joinPath(folder, "..", folderName(connectionName, payload));
            const renameEdit = new vscode.WorkspaceEdit();
            renameEdit.renameFile(folder, newFolder, { overwrite: false });
            const renamed = await vscode.workspace.applyEdit(renameEdit);
            if (!renamed) {
              if (wasWatching) {
                await startWatchingFolder(context, output, activeWatchers, folder);
              }
              throw new Error(
                `Renamed "${oldAppName}" to "${newAppName}" on the server, but failed to rename the ` +
                  `local folder from "${folder.fsPath}" to "${newFolder.fsPath}" (target may already ` +
                  'exist). Run "Tornado: Refresh from Server" to bring the local copy back in sync.',
              );
            }
            finalFolder = newFolder;
            if (wasWatching) {
              await startWatchingFolder(context, output, activeWatchers, newFolder);
            }
          }

          output.appendLine(`Updated properties of application "${newAppName}" (id ${current.appid}).`);
          // Every field this command edits (appname/appgroup/description/
          // templatename/inheritfrom) is rendered somewhere in the
          // Inventory tree — re-fetch rather than leave it
          // showing stale values until the next manual refresh.
          treeProvider.refresh();
          vscode.window.showInformationMessage(
            finalFolder.fsPath !== folder.fsPath
              ? `Updated "${newAppName}" on the Tornado server and renamed the local folder to ${finalFolder.fsPath}.`
              : `Updated "${newAppName}" on the Tornado server.`,
          );
        } catch (error) {
          output.appendLine(`Failed to update application properties: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
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
