import * as vscode from "vscode";
import { createHash } from "node:crypto";
import * as path from "node:path";
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
  AppParam,
  DesignElementPayload,
  DesignParam,
  NewApplicationPayload,
  NewDesignElementPayload,
  InventoryItem,
  TornadoClient,
} from "./tornadoClient";
import { INHERITED_APP_URI_SCHEME, InventoryTreeProvider } from "./inventoryTreeProvider";
import {
  assertSafePathSegment,
  ensureDesignElementFolder,
  folderName,
  writeDataConnections,
} from "./workspaceStorage";
import {
  DesignSyncResult,
  DEV_CONFIG_RELATIVE_PATH,
  Manifest,
  ManifestEntry,
  MANIFEST_FILENAME,
  designTypeFolder,
  ensureDevConfig,
  fileNameFor,
  inferContentType,
  isNestedJavaClassName,
  readManifest,
  supportsDesignParams,
  useSourceField,
  writeDesignElements,
  writeManifestFile,
} from "./designSync";
import { AppWatcher } from "./appWatcher";
import { openKeywordEditor } from "./keywordEditor";
import { createOutputChannel, logError, traceCommand } from "./logging";
import { CompileDiagnostic, compileApp, ensureServerLibraries, SERVER_LIB_FOLDER } from "./javaCompiler";
import { ensureJavaIntelliSense, removeJavaIntelliSense } from "./javaIntellisense";
import { JavaCompileStatusProvider } from "./javaCompileStatus";

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
  forceLibraryRefresh = false,
): Promise<DesignSyncResult> {
  const { client } = await buildClientForConnection(context, output, connectionId);

  const design = await client.fetchApplicationDesign(appid);
  const existingWatcher = activeWatchers.get(appFolder.toString());
  output.appendLine(`Writing ${design.designelements.length} design element(s) to disk...`);

  // devconfig.json and DataConnections/ are both settled inside the same
  // suppressed block: writing them is part of the sync, not a local edit
  // for the watcher to echo back as an upload.
  const writeAll = async (): Promise<DesignSyncResult> => {
    const written = await writeDesignElements(
      appFolder,
      appid,
      connectionId,
      design.designelements,
      design.appparams,
      output,
    );
    await ensureDevConfig(appFolder, appid, client, written.manifest, output);

    // Best-effort metadata for local AI tooling — a data connection only
    // shows up once the app that owns it is opened, so this is the point to
    // catch it. Never let a failure here (a bad connection name, a write
    // error) look like the design sync itself failed.
    try {
      await writeDataConnections(appFolder, design.dataconnections);
    } catch (error) {
      logError(output, `Failed to write DataConnections metadata: ${(error as Error).message}`);
    }
    return written;
  };
  const result = existingWatcher
    ? await existingWatcher.runSuppressed(writeAll)
    : await writeAll();
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
    await ensureServerLibraries(tornadoRoot, appFolder, connectionId, client, output, forceLibraryRefresh);
    const justConfigured = await ensureJavaIntelliSense(output, appFolder);
    if (justConfigured) {
      vscode.window.showInformationMessage(
        "Tornado: pointed the Java editor at the server's jars and source folders for IntelliSense. If " +
          "types or fields still show as unresolved, run 'Java: Clean the Java Language Server Workspace' " +
          "or reload the window.",
      );
    }
  } catch (error) {
    logError(output, `Could not refresh server libraries: ${(error as Error).message}`);
  }

  return result;
}

export interface CompileAndUploadSummary {
  uploaded: number;
  unchanged: number;
  skipped: number;
  hadErrors: boolean;
  failedSourceNames: string[];
}

// ecj batch-compiles every source together on every run (see
// JAVA_SOURCE_FOLDERS in javaCompiler.ts) and zbin/ is wiped each time, so
// without this a single edited Action still re-uploads every other
// unchanged class too. Source is folded in for top-level classes (empty for
// nested ones, which never carry designsource) so a source-only edit that
// happens not to change the compiled bytecode still re-uploads and keeps
// the server's designsource in sync with what's on disk.
function hashUpload(classBytes: Uint8Array, sourceBytes: Uint8Array): string {
  return createHash("sha256").update(classBytes).update(sourceBytes).digest("hex");
}

// Populates VS Code's native Problems panel (and editor squiggles) with
// ecj's actual diagnostics for this batch — reset for every source in the
// batch on every compile (not just the ones with a problem this time), so a
// file that's now clean doesn't leave a stale entry behind. The range
// covers the whole reported line rather than the exact token: ecj's caret
// line would let this be pinned more precisely, but reproducing its
// tab/space column math reliably isn't worth it for what's still a useful,
// correctly-positioned squiggle.
function updateJavaDiagnostics(
  collection: vscode.DiagnosticCollection,
  sourceFsPaths: readonly string[],
  diagnostics: readonly CompileDiagnostic[],
): void {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of diagnostics) {
    const line = Math.max(0, d.line - 1);
    const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
    const diagnostic = new vscode.Diagnostic(
      range,
      d.message,
      d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = "Tornado (ecj)";
    const list = byFile.get(d.fsPath) ?? [];
    list.push(diagnostic);
    byFile.set(d.fsPath, list);
  }
  for (const fsPath of sourceFsPaths) {
    collection.set(vscode.Uri.file(fsPath), byFile.get(fsPath) ?? []);
  }
}

// Same folder-scoping as JavaCompileStatusProvider.clearFolder(), so a
// wiped-and-resynced or closed app doesn't leave stale entries in the
// Problems panel for files that are about to be recreated or are simply
// gone.
function clearJavaDiagnosticsForFolder(collection: vscode.DiagnosticCollection, folder: vscode.Uri): void {
  const prefix = folder.fsPath + path.sep;
  const toClear: vscode.Uri[] = [];
  collection.forEach((uri) => {
    if (uri.fsPath.startsWith(prefix)) {
      toClear.push(uri);
    }
  });
  for (const uri of toClear) {
    collection.delete(uri);
  }
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
  compileStatus: JavaCompileStatusProvider,
  javaDiagnostics: vscode.DiagnosticCollection,
): Promise<CompileAndUploadSummary | undefined> {
  const manifest = await readManifest(folder);
  if (!manifest) {
    throw new Error(`No manifest found in ${folder.fsPath}.`);
  }
  const { client } = await buildClientForConnection(context, output, manifest.connectionId);

  // ensureJavaIntelliSense is otherwise only called on sync/refresh — an app
  // synced before that wiring existed (or before this app's own SharedCode
  // grew enough to need it) would otherwise never get java.project.sourcePaths
  // until the user happens to re-sync it, leaving IntelliSense unable to
  // resolve the app's own classes across files indefinitely. Cheap to call
  // here too: a no-op once already configured, non-fatal if it fails.
  try {
    const justConfigured = await ensureJavaIntelliSense(output, folder);
    if (justConfigured) {
      vscode.window.showInformationMessage(
        "Tornado: pointed the Java editor at the server's jars and source folders for IntelliSense. If " +
          "types or fields still show as unresolved, run 'Java: Clean the Java Language Server Workspace' " +
          "or reload the window.",
      );
    }
  } catch (error) {
    logError(output, `Could not configure Java IntelliSense: ${(error as Error).message}`);
  }

  const result = await compileApp(folder, manifest.connectionId, client, context.globalStorageUri, output);
  if (!result) {
    return undefined;
  }
  // Badge every source in this batch green/red in the Explorer, regardless
  // of whether its class made it onto the server below.
  compileStatus.record(result.sourceFiles, new Set(result.erroredSourceFiles));
  updateJavaDiagnostics(javaDiagnostics, result.sourceFiles, result.diagnostics);

  let uploaded = 0;
  let unchanged = 0;
  let skipped = 0;
  let manifestChanged = false;
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
    let sourceBytes: Uint8Array = new Uint8Array(0);
    let sourceBase64 = "";
    try {
      sourceBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, entry.path));
      sourceBase64 = Buffer.from(sourceBytes).toString("base64");
    } catch {
      output.appendLine(`  ${entry.path} not found — uploading compiled class without refreshing source.`);
    }

    const hash = hashUpload(classBytes, sourceBytes);
    if (entry.uploadedHash === hash) {
      unchanged++;
      continue;
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
    entry.uploadedHash = hash;
    manifestChanged = true;
    output.appendLine(`Uploaded compiled "${entry.name}" (${classBytes.length} bytes).`);
    uploaded++;
  }

  // Nested/inner/anonymous classes (e.g. Foo$Bar.class) have no .java of
  // their own to match a manifest entry by name — they're deployed as
  // SharedCode (designtype 4), created on the server the first time each
  // one is seen and updated in place on every compile after that.
  for (const classFileUri of result.nestedClassFiles) {
    const fileName = classFileUri.path.split("/").pop() ?? "";
    const className = fileName.replace(/\.class$/, "");
    const classBytes = await vscode.workspace.fs.readFile(classFileUri);
    const designdata = Buffer.from(classBytes).toString("base64");
    const hash = hashUpload(classBytes, new Uint8Array(0));

    const entry = manifest.elements.find((e) => e.name === className && e.designtype === 4);
    if (entry) {
      if (entry.uploadedHash === hash) {
        unchanged++;
        continue;
      }
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
      entry.uploadedHash = hash;
      manifestChanged = true;
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
      uploadedHash: hash,
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

  return { uploaded, unchanged, skipped, hadErrors: result.hadErrors, failedSourceNames: result.failedSourceNames };
}

type FolderResetChoice = "fresh" | "merge" | "cancel";

// Opening an app from the Inventory tree replaces the local copy rather than
// writing over the top of it — otherwise a design element deleted on the
// server lingers locally forever, and a stale file can be uploaded back by
// the watcher. Since that discards local work, it's confirmed first, and
// only when there's actually something to discard.
//
// Returns what the caller should do next: "fresh" (folder is now empty —
// sync into it), "merge" (leave it alone and write over the top, the old
// behaviour), or "cancel".
async function confirmAndResetAppFolder(
  folder: vscode.Uri,
  output: vscode.OutputChannel,
  activeWatchers: Map<string, AppWatcher>,
  compileStatus: JavaCompileStatusProvider,
  javaDiagnostics: vscode.DiagnosticCollection,
): Promise<FolderResetChoice> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(folder);
  } catch {
    // Brand new folder — nothing to delete, nothing to confirm.
    return "fresh";
  }
  if (entries.length === 0) {
    return "fresh";
  }

  const freshAction = "Delete & Sync Fresh";
  const mergeAction = "Sync Without Deleting";
  const choice = await vscode.window.showWarningMessage(
    `Replace the local copy of this application at ${folder.fsPath}?`,
    {
      modal: true,
      detail:
        "Everything in that folder is deleted first, so the copy pulled down matches the server " +
        "exactly. Local edits that haven't been uploaded will be lost, along with compiled output " +
        "in zbin/. Documentation/devconfig.json is kept.\n\n" +
        '"Sync Without Deleting" writes the server\'s copy over the top instead, leaving anything ' +
        "the server no longer has in place.",
    },
    freshAction,
    mergeAction,
  );
  if (choice === mergeAction) {
    return "merge";
  }
  if (choice !== freshAction) {
    return "cancel";
  }

  // devconfig.json is local dev-tooling config, not server design — it holds
  // the per-app javaVersion override and is meant to survive re-syncing (see
  // ensureDevConfig), so it's carried across the delete rather than reset to
  // the default.
  let devConfig: Uint8Array | undefined;
  try {
    devConfig = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(folder, DEV_CONFIG_RELATIVE_PATH),
    );
  } catch {
    devConfig = undefined;
  }

  // Stop watching *before* deleting: the watcher treats a local delete as
  // "the user removed this design element" and asks whether to delete it on
  // the server too, which is the last thing a refresh should trigger.
  // Suppression isn't enough — it lifts on a timer, and this can outlast it.
  const key = folder.toString();
  const watcher = activeWatchers.get(key);
  if (watcher) {
    watcher.dispose();
    activeWatchers.delete(key);
    output.appendLine(`Stopped watching ${folder.fsPath} while replacing it.`);
  }

  // Prefer the trash, so a mistaken confirmation is still recoverable from
  // the OS. Not every filesystem supports it, hence the fallback.
  try {
    await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: true });
  } catch {
    await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
    output.appendLine("  (deleted permanently — the trash was unavailable)");
  }
  await vscode.workspace.fs.createDirectory(folder);
  output.appendLine(`Deleted the local copy at ${folder.fsPath} before syncing a fresh one.`);
  compileStatus.clearFolder(folder);
  clearJavaDiagnosticsForFolder(javaDiagnostics, folder);

  if (devConfig) {
    const devConfigUri = vscode.Uri.joinPath(folder, DEV_CONFIG_RELATIVE_PATH);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(devConfigUri, ".."));
    await vscode.workspace.fs.writeFile(devConfigUri, devConfig);
    output.appendLine(`  kept ${DEV_CONFIG_RELATIVE_PATH}`);
  }
  return "fresh";
}

// "/appgroup/appname" (appgroup dropped when empty, i.e. ungrouped) — used
// wherever an app is named in UI text, so an app is distinguishable from a
// same-named app in a different group.
function appPathLabel(app: Pick<InventoryItem, "appgroup" | "appname">): string {
  return `/${[app.appgroup, app.appname].filter((part) => part.length > 0).join("/")}`;
}

function formatCompileSummary(result: CompileAndUploadSummary): string {
  const parts = [`uploaded ${result.uploaded} Java design element(s)`];
  if (result.unchanged > 0) {
    parts.push(`${result.unchanged} unchanged (not re-uploaded)`);
  }
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

interface FieldChoice {
  label: string;
  value: string;
}

interface EditableFieldDef<K extends string> {
  key: K;
  label: string;
  prompt: string;
  // How the value is entered. "text" (the default) is a plain input box;
  // "choice" opens a second QuickPick built from choices(); "flag" is the
  // Tornado convention of a parameter that's either "1" or simply absent.
  kind?: "text" | "choice" | "flag";
  choices?: () => FieldChoice[];
  // Value -> what's shown next to the field name (e.g. "en-AU" shown as
  // "English (Australia)"). Not applied to empty values, which always show
  // emptyLabel instead.
  describe?: (value: string) => string;
  emptyLabel?: string;
}

interface PropertyQuickPickItem<K extends string> extends vscode.QuickPickItem {
  action: "edit" | "save" | "cancel";
  field?: K;
}

interface ChoiceQuickPickItem extends vscode.QuickPickItem {
  // undefined means "let me type a value instead" — the escape hatch for a
  // value the choice list can't know about.
  value?: string;
  manual?: boolean;
}

const FLAG_SET_VALUE = "1";

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
      ...fields.map((field) => {
        const value = valueOf(field.key);
        return {
          label: field.label,
          description: value ? field.describe?.(value) ?? value : field.emptyLabel ?? "(empty)",
          action: "edit" as const,
          field: field.key,
        };
      }),
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
    const newValue = await promptForFieldValue(field, valueOf(field.key));
    // Escaping out of the value prompt (or its sub-picker) drops back to the
    // list without recording an edit, rather than cancelling the whole dialog.
    if (newValue === undefined) {
      continue;
    }
    edits[field.key] = newValue;
  }
}

// The per-field half of editPropertiesViaQuickPick above: turns one field
// definition into whatever input its kind calls for. Returns undefined when
// the user backs out without choosing.
async function promptForFieldValue<K extends string>(
  field: EditableFieldDef<K>,
  currentValue: string,
): Promise<string | undefined> {
  if (field.kind === "flag") {
    const picked = await vscode.window.showQuickPick<ChoiceQuickPickItem>(
      [
        {
          label: `Set ('${FLAG_SET_VALUE}')`,
          description: currentValue !== "" ? "current" : undefined,
          value: FLAG_SET_VALUE,
        },
        {
          label: "Not set",
          description: currentValue === "" ? "current — removes this parameter" : "removes this parameter",
          value: "",
        },
      ],
      { title: field.prompt, ignoreFocusOut: true },
    );
    return picked?.value;
  }

  if (field.kind === "choice") {
    const choices = field.choices?.() ?? [];
    const picked = await vscode.window.showQuickPick<ChoiceQuickPickItem>(
      [
        { label: "$(circle-slash) (not set)", value: "" },
        ...choices.map((choice) => ({
          label: choice.label,
          description: choice.label === choice.value ? undefined : choice.value,
          value: choice.value,
        })),
        // The choice list is built from local state (the manifest, a static
        // locale list), so a value that's valid server-side but not synced
        // locally would otherwise be unreachable.
        { label: "$(edit) Enter a value manually...", manual: true },
      ],
      { title: field.prompt, ignoreFocusOut: true },
    );
    if (!picked) {
      return undefined;
    }
    if (!picked.manual) {
      return picked.value;
    }
  }

  return vscode.window.showInputBox({
    prompt: field.prompt,
    value: currentValue,
    ignoreFocusOut: true,
  });
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

// Offered for DefaultLocale. Not exhaustive by design — the picker's
// "Enter a value manually..." escape hatch covers any tag not listed here.
const LOCALE_CODES = [
  "en-AU", "en-CA", "en-GB", "en-IE", "en-IN", "en-NZ", "en-US", "en-ZA",
  "ar-SA", "cs-CZ", "da-DK", "de-AT", "de-CH", "de-DE", "el-GR", "es-ES",
  "es-MX", "fi-FI", "fr-CA", "fr-FR", "he-IL", "hi-IN", "hu-HU", "id-ID",
  "it-IT", "ja-JP", "ko-KR", "ms-MY", "nb-NO", "nl-NL", "pl-PL", "pt-BR",
  "pt-PT", "ro-RO", "ru-RU", "sv-SE", "th-TH", "tr-TR", "uk-UA", "vi-VN",
  "zh-CN", "zh-HK", "zh-TW",
];

// "en-AU" -> "English (Australia)". languageDisplay: "standard" is what
// produces that parenthesised form — the default ("dialect") renders
// "Australian English" instead. Older ICU builds ignore the option, so the
// dialect form is detected (no parentheses) and composed by hand from the
// language and region subtags. Falls back to the raw tag throughout: a
// display-name lookup must never be why this command fails.
function localeLabel(code: string): string {
  try {
    const asLanguage = new Intl.DisplayNames(["en"], {
      type: "language",
      languageDisplay: "standard",
    });
    const label = asLanguage.of(code);
    if (!label || label === code) {
      return code;
    }
    const region = code.split("-")[1];
    if (label.includes("(") || !region) {
      return label;
    }
    const base = asLanguage.of(code.split("-")[0]) ?? code;
    const regionName = new Intl.DisplayNames(["en"], { type: "region" }).of(region) ?? region;
    return `${base} (${regionName})`;
  } catch {
    return code;
  }
}

function localeChoices(): FieldChoice[] {
  return LOCALE_CODES.map((code) => ({ label: localeLabel(code), value: code })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

// Design element names of one type, from the already-loaded manifest — no
// round trip. Reflects the last sync, which is why every choice picker also
// offers manual entry.
function designElementChoices(manifest: Manifest, designtype: number): FieldChoice[] {
  const names = [...new Set(manifest.elements.filter((e) => e.designtype === designtype).map((e) => e.name))];
  return names.sort((a, b) => a.localeCompare(b)).map((name) => ({ label: name, value: name }));
}

const ACTION_DESIGN_TYPE = 3;
const PAGE_DESIGN_TYPE = 1;

// Field constructors shared by the application-parameter and design-element-
// parameter editors below. Both edit a {paramname, paramvalue}[] where a
// parameter's *absence* is meaningful, so both label an empty value
// "(not set)" rather than "(empty)".
function flagParamField(key: string, prompt: string): EditableFieldDef<string> {
  return { key, label: key, prompt, kind: "flag", emptyLabel: "(not set)" };
}

function choiceParamField(
  key: string,
  prompt: string,
  choices: () => FieldChoice[],
): EditableFieldDef<string> {
  return { key, label: key, prompt, kind: "choice", choices, emptyLabel: "(not set)" };
}

function textParamField(key: string, prompt: string): EditableFieldDef<string> {
  return { key, label: key, prompt, emptyLabel: "(not set)" };
}

// Parameters already set on the server that aren't among the known names for
// this application/design type — appended as plain text fields so they're
// visible and editable rather than silently carried through the save.
function appendUnknownParamFields(
  fields: EditableFieldDef<string>[],
  current: { paramname: string }[],
): EditableFieldDef<string>[] {
  for (const param of current) {
    if (!fields.some((field) => field.key === param.paramname)) {
      fields.push(textParamField(param.paramname, `Value for ${param.paramname}`));
    }
  }
  return fields;
}

interface ParamMergeResult {
  params: AppParam[];
  changes: string[];
}

// Turns the edits a QuickPick session produced into the full parameter array
// to send, plus a human-readable list of what actually changed (empty when
// nothing did, so the caller can skip the write entirely).
//
// Server order comes first so untouched parameters keep their place, then
// any known name being set for the first time. A parameter is dropped only
// when it was *edited* to empty — one the server already has with a blank
// value and nobody touched is re-sent as it was, so saving one field can't
// quietly delete another.
function mergeParamEdits(
  current: { paramname: string; paramvalue: string }[],
  fields: EditableFieldDef<string>[],
  edits: Partial<Record<string, string>>,
): ParamMergeResult {
  // String() rather than a bare cast: these arrays come straight from the
  // server, and a paramvalue serialised as a number (e.g. 1 for a flag)
  // would otherwise blow up on .trim() below.
  const currentByName = new Map(current.map((param) => [param.paramname, String(param.paramvalue ?? "")]));
  const changes: string[] = [];
  const params: AppParam[] = [];
  const emitted = new Set<string>();

  const emit = (paramname: string): void => {
    if (emitted.has(paramname)) {
      return;
    }
    emitted.add(paramname);
    const edited = edits[paramname];
    const existing = currentByName.get(paramname);
    const value = (edited ?? existing ?? "").trim();
    if (edited !== undefined && edited.trim() !== (existing ?? "").trim()) {
      changes.push(value ? `Set ${paramname} = "${value}"` : `Cleared ${paramname}`);
    }
    if (value === "" && (edited !== undefined || existing === undefined)) {
      return;
    }
    params.push({ paramname, paramvalue: value });
  };

  for (const param of current) {
    emit(param.paramname);
  }
  for (const field of fields) {
    emit(field.key);
  }
  return { params, changes };
}

// The current value of each field, for editPropertiesViaQuickPick.
function paramValueLookup(current: { paramname: string; paramvalue: string }[]): (key: string) => string {
  const byName = new Map(current.map((param) => [param.paramname, String(param.paramvalue ?? "")]));
  return (key) => byName.get(key) ?? "";
}

function buildAppParamFields(manifest: Manifest, current: AppParam[]): EditableFieldDef<string>[] {
  const actions = (): FieldChoice[] => designElementChoices(manifest, ACTION_DESIGN_TYPE);
  const pages = (): FieldChoice[] => designElementChoices(manifest, PAGE_DESIGN_TYPE);
  const action = (key: string): EditableFieldDef<string> =>
    choiceParamField(key, `Action to run for ${key}`, actions);

  return appendUnknownParamFields(
    [
      action("OpenAction"),
      action("OpenAction1"),
      action("SaveAction"),
      action("SaveAction1"),
      choiceParamField("LoginPage", "Page to use as the login page", pages),
      textParamField("DefaultOpen", "What the application opens by default"),
      flagParamField("DisableApp", "Disable this application"),
      flagParamField("DisableScheduledActions", "Disable this application's scheduled actions"),
      {
        ...choiceParamField("DefaultLocale", "Default locale for this application", localeChoices),
        describe: localeLabel,
      },
      flagParamField("ForceSecureConn", "Force connections to this application over HTTPS"),
    ],
    current,
  );
}

// Which design parameters a design element has depends on its type, mirroring
// the server's own saveParams(): Pages additionally carry OpenAction,
// SaveAction and ParentPage, while the three flags below apply to every type.
function buildDesignParamFields(
  manifest: Manifest,
  designtype: number,
  current: DesignParam[],
): EditableFieldDef<string>[] {
  const actions = (): FieldChoice[] => designElementChoices(manifest, ACTION_DESIGN_TYPE);
  const pages = (): FieldChoice[] => designElementChoices(manifest, PAGE_DESIGN_TYPE);

  const fields: EditableFieldDef<string>[] = [];
  if (designtype === PAGE_DESIGN_TYPE) {
    fields.push(
      choiceParamField("OpenAction", "Action to run when this page is opened", actions),
      choiceParamField("SaveAction", "Action to run when this page is saved", actions),
      choiceParamField("ParentPage", "Page this page is nested inside", pages),
    );
  }
  fields.push(
    flagParamField("AnonymousAccess", "Allow access without logging in"),
    flagParamField("MinifyLevel", "Minify this element"),
    flagParamField("CompositeElement", "Treat this element as a composite element"),
  );
  return appendUnknownParamFields(fields, current);
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

// After "Tornado: Close Application" deletes one app's folder, its
// connection's tornado/.lib/<connectionId>/ cache (see SERVER_LIB_FOLDER in
// javaCompiler.ts) is only worth keeping if some other synced app on that
// same connection still exists — otherwise it's just orphaned disk usage a
// future sync/refresh would re-download from scratch anyway.
async function pruneOrphanedLibraryCache(
  tornadoRoot: vscode.Uri,
  connectionId: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const libDir = vscode.Uri.joinPath(tornadoRoot, SERVER_LIB_FOLDER, connectionId);
  try {
    await vscode.workspace.fs.stat(libDir);
  } catch {
    return; // Nothing cached for this connection — nothing to prune.
  }

  const manifests = await vscode.workspace.findFiles(
    new vscode.RelativePattern(tornadoRoot, `*/${MANIFEST_FILENAME}`),
  );
  for (const uri of manifests) {
    const manifest = await readManifest(vscode.Uri.joinPath(uri, ".."));
    if (manifest?.connectionId === connectionId) {
      return; // Still referenced by another synced app on this connection.
    }
  }

  try {
    await vscode.workspace.fs.delete(libDir, { recursive: true, useTrash: true });
  } catch {
    await vscode.workspace.fs.delete(libDir, { recursive: true, useTrash: false });
  }
  output.appendLine(
    `No other synced app uses connection "${connectionId}" — deleted its shared library cache at ${libDir.fsPath}.`,
  );
}

// Given a file open in the editor (or right-clicked in the Explorer), walks
// up its ancestors looking for a synced app's manifest — a design element's
// path is always exactly two levels under its app folder (<DesignTypeFolder>/
// <file>), but walking rather than hardcoding that depth means this keeps
// working if that ever changes. devconfig.json is excluded even though it is
// now a real Documentation element on the server: it's the extension's own
// configuration, and renaming or re-pointing it through the design-element
// property editors would only break the lookup that reads it.
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
  const output = createOutputChannel();
  context.subscriptions.push(output);
  output.appendLine("Tornado extension activated.");
  const activeWatchers = new Map<string, AppWatcher>();

  // Every command goes through traceCommand, so the log shows what ran, what
  // it was aimed at, and whether it finished — not just the milestones each
  // command chooses to report.
  const registerTracedCommand = (
    id: string,
    handler: (...args: never[]) => unknown,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(id, traceCommand(output, id, handler as (...args: unknown[]) => unknown));

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

  // Badges Actions/SharedCode/ScheduledActions .java files green/red in the
  // Explorer based on their last compile — updated by compileAndUploadFolder
  // after every manual or auto-compile-on-save run (see javaCompileStatus.ts).
  const compileStatus = new JavaCompileStatusProvider();
  context.subscriptions.push(compileStatus, vscode.window.registerFileDecorationProvider(compileStatus));

  // The actual ecj error/warning messages, same lifecycle as compileStatus
  // above (updated by compileAndUploadFolder every compile) — this is what
  // makes a broken class visible in VS Code's native Problems panel and as
  // an editor squiggle, not just a red badge with no detail.
  const javaDiagnostics = vscode.languages.createDiagnosticCollection("tornado-java");
  context.subscriptions.push(javaDiagnostics);

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
    registerTracedCommand("tornado.addConnection", async () => {
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
    registerTracedCommand("tornado.selectConnection", async () => {
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
    registerTracedCommand("tornado.editConnection", async () => {
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
    registerTracedCommand("tornado.deleteConnection", async () => {
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
    registerTracedCommand("tornado.refreshInventory", async () => {
      try {
        treeProvider.setClient(await buildClient(context, output));
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to refresh Tornado inventory: ${(error as Error).message}`);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.expandAllAppGroups", async () => {
      await treeProvider.expandAll();
    }),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.collapseAllAppGroups", async () => {
      // Two home-grown approaches (mutating collapsibleState + a per-element
      // change event; a full no-arg refresh relying on no `id` being set) both
      // failed to actually collapse anything in practice, despite matching
      // the documented/expected TreeView behavior. This delegates to VS
      // Code's own internal implementation instead — the exact command its
      // native "Collapse All" button (enabled via showCollapseAll in
      // package.json) invokes — since that's the one thing guaranteed to
      // actually work.
      await vscode.commands.executeCommand("workbench.actions.treeView.tornadoInventory.collapseAll");
    }),
  );

  context.subscriptions.push(
    registerTracedCommand(
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

          // Captured before the reset below, which tears the watcher down so
          // its delete handler can't mistake the wipe for the user removing
          // design elements. Restarted after the sync if it was running.
          const wasWatching = activeWatchers.has(folder.toString());
          const reset = await confirmAndResetAppFolder(folder, output, activeWatchers, compileStatus, javaDiagnostics);
          if (reset === "cancel") {
            output.appendLine(`Sync of "${app.appname}" cancelled — the local copy was left alone.`);
            return;
          }

          const appid = app.appid;
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Syncing "${appPathLabel(app)}"...`,
            },
            // forceLibraryRefresh: true — this is also the click-to-sync path
            // from the Inventory tree, so a stale .lib cache from an earlier
            // session shouldn't silently linger every time an app is opened.
            () => syncDesignToFolder(context, output, activeWatchers, folder, appid, connection.id, true),
          );

          if (wasWatching) {
            // Only ever stopped by the reset path; restart it so "opening"
            // an app that was being watched doesn't quietly stop watching it.
            if (!activeWatchers.has(folder.toString())) {
              await startWatchingFolder(context, output, activeWatchers, folder);
              output.appendLine(`Resumed watching ${folder.fsPath}.`);
            }
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
          logError(output, `Sync failed: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.createApplication", async () => {
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
        logError(output, `Failed to create application: ${(error as Error).message}`);
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
        logError(output, `Local sync of the new application failed: ${(error as Error).message}`);
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
    registerTracedCommand("tornado.startWatching", async () => {
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
    registerTracedCommand("tornado.refreshFromServer", async () => {
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
          () =>
            syncDesignToFolder(
              context,
              output,
              activeWatchers,
              folder,
              manifest.appid,
              manifest.connectionId,
              true,
            ),
        );
        vscode.window.showInformationMessage(
          `Refreshed ${result.written} design element(s) in ${folder.fsPath}`,
        );
      } catch (error) {
        logError(output, `Refresh failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.stopWatching", async () => {
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
    registerTracedCommand("tornado.compileAndUpload", async () => {
      const folder = await pickSyncedAppFolder("Select an application to compile and upload");
      if (!folder) {
        return;
      }
      try {
        const result = await compileAndUploadFolder(context, output, folder, compileStatus, javaDiagnostics);
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
        logError(output, `Compile & upload failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.compileHealthCheck", async (uri?: vscode.Uri) => {
      const folder = uri ?? (await pickSyncedAppFolder("Select an application to check compile health for"));
      if (!folder) {
        return;
      }
      const appLabel = folder.fsPath.split("/").pop() ?? folder.fsPath;

      // Reads the status recorded by the app's last actual compile (Compile
      // & Upload, or auto-compile-on-save) rather than triggering a new
      // one — a quick "what's currently broken" check, not another build.
      if (!compileStatus.hasRecordedStatus(folder)) {
        vscode.window.showInformationMessage(
          `"${appLabel}" hasn't been compiled yet this session — run "Tornado: Compile & Upload Java" ` +
            "first, then check again.",
        );
        return;
      }

      const errored = compileStatus.erroredFiles(folder);
      if (errored.length === 0) {
        vscode.window.showInformationMessage(`"${appLabel}": no compile errors as of its last compile.`);
        return;
      }

      const picked = await vscode.window.showQuickPick(
        errored
          .map((fsPath) => {
            const messages = (javaDiagnostics.get(vscode.Uri.file(fsPath)) ?? []).map((d) => d.message);
            return {
              label: fsPath.split("/").pop() ?? fsPath,
              description: vscode.workspace.asRelativePath(fsPath, false),
              detail: messages.length > 0 ? messages.join(" · ") : "(no ecj message recorded for this file)",
              fsPath,
            };
          })
          .sort((a, b) => a.label.localeCompare(b.label)),
        {
          placeHolder: `${errored.length} class(es) with compile errors in "${appLabel}" — select one to open it`,
          matchOnDetail: true,
        },
      );
      if (picked) {
        const document = await vscode.workspace.openTextDocument(picked.fsPath);
        await vscode.window.showTextDocument(document);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.refreshServerLibraries", async () => {
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
        await ensureJavaIntelliSense(output, folder);
        vscode.window.showInformationMessage(`Refreshed server libraries for "${connectionName}".`);
      } catch (error) {
        logError(output, `Refreshing server libraries failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.closeApplication", async (uri?: vscode.Uri) => {
      const folder = uri ?? (await pickSyncedAppFolder("Select an application to close"));
      if (!folder) {
        return;
      }
      const manifest = await readManifest(folder);
      if (!manifest) {
        vscode.window.showErrorMessage(`No manifest found in ${folder.fsPath}.`);
        return;
      }

      const appLabel = folder.fsPath.split("/").pop() ?? folder.fsPath;
      const closeAction = "Close & Delete Local Copy";
      const confirmed = await vscode.window.showWarningMessage(
        `Close "${appLabel}" and delete its local copy at ${folder.fsPath}?`,
        {
          modal: true,
          detail:
            "Only the local copy is removed — nothing is pushed to or deleted from the Tornado " +
            "server. Watching (if active) is stopped first. The folder goes to the OS trash where " +
            "available, so this is usually recoverable there, but not from within the extension.",
        },
        closeAction,
      );
      if (confirmed !== closeAction) {
        return;
      }

      try {
        // Stop watching *before* deleting — the watcher treats a local
        // delete as the user removing design elements and would prompt to
        // delete them server-side too, which "Close" must never do. Matched
        // by appFolder.fsPath rather than the map key (folder.toString())
        // since this folder — unlike every other activeWatchers lookup —
        // can come straight from an Explorer right-click rather than a URI
        // the extension built itself.
        const watcherEntry = [...activeWatchers.entries()].find(
          ([, watcher]) => watcher.appFolder.fsPath === folder.fsPath,
        );
        if (watcherEntry) {
          const [key, watcher] = watcherEntry;
          watcher.dispose();
          activeWatchers.delete(key);
          output.appendLine(`Stopped watching ${folder.fsPath} before closing it.`);
        }

        await removeJavaIntelliSense(output, folder);
        compileStatus.clearFolder(folder);
        clearJavaDiagnosticsForFolder(javaDiagnostics, folder);

        try {
          await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: true });
        } catch {
          await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
          output.appendLine("  (deleted permanently — the trash was unavailable)");
        }
        output.appendLine(`Closed "${appLabel}" — deleted the local copy at ${folder.fsPath}.`);

        // .lib/<connectionId>/ (the shared jar cache) is keyed per-connection,
        // not per-app — only worth deleting once no other synced app on this
        // connection needs it any more.
        const tornadoRoot = vscode.Uri.joinPath(folder, "..");
        await pruneOrphanedLibraryCache(tornadoRoot, manifest.connectionId, output);

        vscode.window.showInformationMessage(`Closed "${appLabel}" and removed its local copy.`);
      } catch (error) {
        logError(output, `Closing "${appLabel}" failed: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand(
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
            // The same fileNameFor() writeDesignElements uses for the
            // download direction — keeps the local filename in step with what
            // the next refresh-from-server would produce anyway.
            const folderPart = oldPath.slice(0, oldPath.lastIndexOf("/"));
            const newFileName = fileNameFor(newName, entry.designtype, entry.contenttype);
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
          logError(output, `Failed to update design element properties: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
  );

  context.subscriptions.push(
    registerTracedCommand(
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
          logError(output, `Failed to update application properties: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
  );

  context.subscriptions.push(
    registerTracedCommand("tornado.editKeywords", async (uri?: vscode.Uri) => {
      const folder = uri ?? (await pickSyncedAppFolder("Select an application to edit keywords for"));
      if (!folder) {
        return;
      }
      const manifest = await readManifest(folder);
      if (!manifest) {
        vscode.window.showErrorMessage(`No manifest found in ${folder.fsPath}.`);
        return;
      }
      try {
        const { client } = await buildClientForConnection(context, output, manifest.connectionId);
        await openKeywordEditor(folder, manifest.appid, client, output);
      } catch (error) {
        logError(output, `Failed to open the keyword editor: ${(error as Error).message}`);
        output.show(true);
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    registerTracedCommand(
      "tornado.editDesignElementParameters",
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
        // SharedCode, Documentation and Widgets have no editable parameters.
        // The Explorer's context menu already hides this command for them
        // (see package.json), but the Command Palette route gets here with
        // whatever file is in the active editor, so it's checked again.
        if (!supportsDesignParams(entry.designtype)) {
          const typeName = designTypeFolder(entry.designtype) ?? `design type ${entry.designtype}`;
          vscode.window.showErrorMessage(
            `"${entry.name}" is ${typeName} — design elements of that type have no editable parameters.`,
          );
          return;
        }

        try {
          const { client } = await buildClientForConnection(context, output, manifest.connectionId);
          // The element's parameters have their own endpoint, so this reads
          // and writes just them — the element's content (designdata /
          // designsource) is never fetched or re-sent, and so can't be
          // clobbered by a parameter change.
          const current = await client.fetchDesignParams(manifest.appid, entry.designbucketid);

          const fields = buildDesignParamFields(manifest, entry.designtype, current);
          const edits = await editPropertiesViaQuickPick(
            `Parameters of "${entry.name}"`,
            fields,
            paramValueLookup(current),
          );
          if (!edits || Object.keys(edits).length === 0) {
            return;
          }

          const { params: newParams, changes } = mergeParamEdits(current, fields, edits);
          if (changes.length === 0) {
            vscode.window.showInformationMessage("No design parameters were changed.");
            return;
          }

          await client.updateDesignParams(manifest.appid, entry.designbucketid, newParams);

          // Not optional bookkeeping: the watcher re-sends the *manifest's*
          // designparams with every file upload (see appWatcher.ts), so
          // leaving a stale copy here would silently revert what was just
          // saved the next time the file is edited.
          //
          // Re-read fresh from disk rather than reusing `manifest` as read at
          // command start: the QuickPick can stay open arbitrarily long, and
          // if a local edit to .tornado-manifest.json (e.g. by an external
          // tool) landed while it was open, writing back this command's
          // stale full copy would silently revert it. Wrapped in
          // runSuppressed so the watcher doesn't mistake this write for a
          // local edit needing its own push.
          const watcher = activeWatchers.get(appFolder.toString());
          const applyAndWrite = async (): Promise<void> => {
            const fresh = (await readManifest(appFolder)) ?? manifest;
            const freshEntry = fresh.elements.find((e) => e.path === entry.path);
            if (freshEntry) {
              freshEntry.designparams = newParams;
            }
            await writeManifestFile(appFolder, fresh);
            await watcher?.reloadManifest();
          };
          if (watcher) {
            await watcher.runSuppressed(applyAndWrite);
          } else {
            await applyAndWrite();
          }

          for (const change of changes) {
            output.appendLine(`  ${change}`);
          }
          output.appendLine(
            `Updated ${changes.length} design parameter(s) of "${entry.name}" (id ${entry.designbucketid}).`,
          );
          vscode.window.showInformationMessage(
            `Updated ${changes.length} parameter(s) of "${entry.name}" on the Tornado server.`,
          );
        } catch (error) {
          logError(output, `Failed to update design parameters: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage((error as Error).message);
        }
      },
    ),
  );

  context.subscriptions.push(
    registerTracedCommand(
      "tornado.editApplicationParameters",
      async (uri?: vscode.Uri) => {
        const folder = uri ?? (await pickSyncedAppFolder("Select an application to edit parameters for"));
        if (!folder) {
          return;
        }
        const manifest = await readManifest(folder);
        if (!manifest) {
          vscode.window.showErrorMessage(`No manifest found in ${folder.fsPath}.`);
          return;
        }

        try {
          const { client } = await buildClientForConnection(context, output, manifest.connectionId);
          const current = await client.fetchApplicationParams(manifest.appid);

          const fields = buildAppParamFields(manifest, current);
          const folderLabel = folder.fsPath.split("/").pop() ?? folder.fsPath;
          const edits = await editPropertiesViaQuickPick(
            `Application parameters — ${folderLabel}`,
            fields,
            paramValueLookup(current),
          );
          if (!edits || Object.keys(edits).length === 0) {
            return;
          }

          const { params: newParams, changes } = mergeParamEdits(current, fields, edits);
          if (changes.length === 0) {
            vscode.window.showInformationMessage("No application parameters were changed.");
            return;
          }

          await client.updateApplicationParams(manifest.appid, newParams);

          // Keep the manifest's appparams live, the same way
          // editDesignElementParameters does for a design element's
          // designparams — otherwise it goes stale relative to the server
          // immediately after this edit. Re-read fresh from disk (not the
          // `manifest` read at command start) and wrap in runSuppressed for
          // the same reasons as above.
          const watcher = activeWatchers.get(folder.toString());
          const applyAndWrite = async (): Promise<void> => {
            const fresh = (await readManifest(folder)) ?? manifest;
            fresh.appparams = newParams;
            await writeManifestFile(folder, fresh);
            await watcher?.reloadManifest();
          };
          if (watcher) {
            await watcher.runSuppressed(applyAndWrite);
          } else {
            await applyAndWrite();
          }

          for (const change of changes) {
            output.appendLine(`  ${change}`);
          }
          output.appendLine(
            `Updated ${changes.length} application parameter(s) for app ${manifest.appid}.`,
          );
          vscode.window.showInformationMessage(
            `Updated ${changes.length} application parameter(s) on the Tornado server.`,
          );
        } catch (error) {
          logError(output, `Failed to update application parameters: ${(error as Error).message}`);
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
      const result = await compileAndUploadFolder(context, output, folder, compileStatus, javaDiagnostics);
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
      logError(output, `Auto-compile failed: ${(error as Error).message}`);
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
