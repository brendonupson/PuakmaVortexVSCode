import * as vscode from "vscode";
import {
  DesignElementPayload,
  NewColumnPayload,
  NewDesignElementPayload,
  NewTablePayload,
  TornadoClient,
} from "./tornadoClient";
import {
  AGENT_INSTRUCTION_FILENAMES,
  DEV_CONFIG_RELATIVE_PATH,
  Manifest,
  ManifestColumn,
  ManifestDataConnection,
  ManifestDataConnectionsDiff,
  ManifestEntry,
  ManifestTable,
  MANIFEST_FILENAME,
  diffManifestDataConnections,
  diffManifestParams,
  folderToDesignType,
  inferContentType,
  isJavaSourceUpload,
  readManifest,
  serverNameFor,
  useSourceField,
  writeManifestFile,
} from "./designSync";
import { logError } from "./logging";

// A change under here should be made through .tornado-manifest.json's
// "dataconnections" section, not by hand-editing the dump directly.
const DATA_CONNECTIONS_FOLDER = "DataConnections/";

function tablePayload(table: ManifestTable): NewTablePayload {
  return { tablename: table.tablename, buildorder: table.buildorder, description: table.description };
}

function columnPayload(column: ManifestColumn): NewColumnPayload {
  return {
    attributename: column.attributename,
    type: column.type,
    typesize: column.typesize,
    allownull: column.allownull,
    isprimarykey: column.isprimarykey,
    reftable: column.reftable,
    extraoptions: column.extraoptions,
    cascadedelete: column.cascadedelete,
    autoincrement: column.autoincrement,
    isunique: column.isunique,
    ftindex: column.ftindex,
    description: column.description,
  };
}

export class AppWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private suppressed = false;

  constructor(
    readonly appFolder: vscode.Uri,
    private readonly appid: number,
    private readonly client: TornadoClient,
    private readonly output: vscode.OutputChannel,
    private manifest: Manifest,
  ) {
    const pattern = new vscode.RelativePattern(appFolder, "**/*");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate((uri) => this.dispatch(() => this.handleCreate(uri)));
    this.watcher.onDidChange((uri) => this.dispatch(() => this.handleChange(uri)));
    this.watcher.onDidDelete((uri) => this.dispatch(() => this.handleDelete(uri)));
  }

  dispose(): void {
    this.watcher.dispose();
  }

  // Wraps a bulk local write (a fresh sync of an already-watched app) so
  // the watcher doesn't treat every rewritten file as a real local edit
  // and echo it straight back to the server as a wave of uploads.
  async runSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressed = true;
    try {
      return await fn();
    } finally {
      // FileSystemWatcher events can lag slightly behind the write that
      // triggered them, so give them a moment to drain before resuming.
      setTimeout(() => {
        this.suppressed = false;
      }, 1000);
    }
  }

  async reloadManifest(): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(this.appFolder, MANIFEST_FILENAME),
    );
    this.manifest = JSON.parse(Buffer.from(bytes).toString("utf-8")) as Manifest;
  }

  private dispatch(fn: () => Promise<void>): void {
    if (this.suppressed) {
      return;
    }
    fn().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logError(this.output, `Unexpected watcher error: ${message}`);
    });
  }

  private toRelativePath(uri: vscode.Uri): string | undefined {
    const base = this.appFolder.path.endsWith("/") ? this.appFolder.path : `${this.appFolder.path}/`;
    return uri.path.startsWith(base) ? uri.path.slice(base.length) : undefined;
  }

  private findEntry(relativePath: string): ManifestEntry | undefined {
    return this.manifest.elements.find((entry) => entry.path === relativePath);
  }

  private async persistManifest(): Promise<void> {
    await writeManifestFile(this.appFolder, this.manifest);
  }

  private async handleCreate(uri: vscode.Uri): Promise<void> {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      return;
    }

    const relativePath = this.toRelativePath(uri);
    // devconfig.json is a real Documentation element once the server has one,
    // and is then tracked in the manifest like anything else — edits to it
    // upload via handleChange. It's skipped only *here*, on create: reaching
    // this point means it isn't in the manifest, i.e. the push in
    // ensureDevConfig didn't succeed, and re-attempting it as an incidental
    // file creation isn't this watcher's job.
    if (
      !relativePath ||
      relativePath === MANIFEST_FILENAME ||
      relativePath === DEV_CONFIG_RELATIVE_PATH ||
      AGENT_INSTRUCTION_FILENAMES.includes(relativePath) ||
      this.findEntry(relativePath)
    ) {
      return;
    }
    if (relativePath.startsWith(DATA_CONNECTIONS_FOLDER)) {
      this.output.appendLine(
        `Skipped "${relativePath}": this is a read-only schema dump — edit the "dataconnections" section ` +
          `of ${MANIFEST_FILENAME} instead.`,
      );
      return;
    }

    const [folder, fileName, ...rest] = relativePath.split("/");
    if (!folder || !fileName || rest.length > 0) {
      this.output.appendLine(`Skipped "${relativePath}": expected <DesignTypeFolder>/<file>.`);
      return;
    }
    const designtype = folderToDesignType(folder);
    if (designtype === undefined) {
      this.output.appendLine(`Skipped "${relativePath}": unrecognised design type folder "${folder}".`);
      return;
    }

    const dot = fileName.lastIndexOf(".");
    const ext = dot >= 0 ? fileName.slice(dot) : "";
    const baseName = dot >= 0 ? fileName.slice(0, dot) : fileName;

    if (isJavaSourceUpload(designtype, ext)) {
      this.output.appendLine(
        `Skipped "${relativePath}": Java source/class changes aren't uploaded by the watcher — ` +
          'run "Tornado: Compile & Upload Java" to compile and upload it.',
      );
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const contenttype = inferContentType(designtype, ext);
      const base64 = Buffer.from(bytes).toString("base64");
      const useSource = useSourceField(designtype, contenttype);
      const payload: NewDesignElementPayload = {
        appid: this.appid,
        name: serverNameFor(baseName, ext, designtype),
        designtype,
        contenttype,
        designdata: useSource ? "" : base64,
        designsource: useSource ? base64 : "",
        inheritfrom: null,
        comment: "",
        options: "",
        designparams: [],
      };
      const created = await this.client.createDesignElement(this.appid, payload);
      this.manifest.elements.push({
        path: relativePath,
        designbucketid: created.designbucketid,
        name: created.name,
        designtype: created.designtype,
        contenttype: created.contenttype,
        inheritfrom: created.inheritfrom,
        comment: created.comment,
        options: created.options,
        designparams: created.designparams,
      });
      await this.persistManifest();
      this.output.appendLine(`Created "${relativePath}" on the server (id ${created.designbucketid}).`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to create "${relativePath}" on the Tornado server: ${(error as Error).message}`,
      );
    }
  }

  private async handleChange(uri: vscode.Uri): Promise<void> {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath || AGENT_INSTRUCTION_FILENAMES.includes(relativePath)) {
      return;
    }
    if (relativePath === MANIFEST_FILENAME) {
      return this.handleManifestChange();
    }

    const entry = this.findEntry(relativePath);
    if (!entry) {
      // Not tracked yet — handle like a create (e.g. saved again before
      // the create event for it was processed).
      return this.handleCreate(uri);
    }

    const dot = relativePath.lastIndexOf(".");
    const ext = dot >= 0 ? relativePath.slice(dot) : "";
    if (isJavaSourceUpload(entry.designtype, ext)) {
      this.output.appendLine(
        `Skipped "${relativePath}": Java source/class changes aren't uploaded by the watcher — ` +
          'run "Tornado: Compile & Upload Java" to compile and upload it.',
      );
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const base64 = Buffer.from(bytes).toString("base64");
      const useSource = useSourceField(entry.designtype, entry.contenttype);
      const payload: DesignElementPayload = {
        designbucketid: entry.designbucketid,
        appid: this.appid,
        name: entry.name,
        designtype: entry.designtype,
        contenttype: entry.contenttype,
        designdata: useSource ? "" : base64,
        designsource: useSource ? base64 : "",
        inheritfrom: entry.inheritfrom,
        comment: entry.comment,
        options: entry.options,
        designparams: entry.designparams,
      };
      await this.client.updateDesignElement(this.appid, entry.designbucketid, payload);
      this.output.appendLine(`Uploaded "${relativePath}".`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to upload "${relativePath}": ${(error as Error).message}`);
    }
  }

  // Lets an external edit to .tornado-manifest.json (e.g. by an AI coding
  // agent working directly on disk, bypassing this extension's own edit
  // commands) push a designparams/appparams/dataconnections change to the
  // server — the same fields, and the same TornadoClient calls, the
  // interactive editors already use. Every other field/structural change to
  // a design element is deliberately not synced here; see
  // diffManifestParams(). dataconnections is the exception that DOES sync
  // structure (new/renamed/deleted tables and columns) — see
  // diffManifestDataConnections() and applyDataConnectionsDiff() below for
  // why its deletions are confirmed rather than pushed silently.
  //
  // The two other unsuppressed manifest writes in this class
  // (handleCreate/handleDelete, via persistManifest()) are safe without any
  // special-casing here: both mutate `this.manifest` in memory *before*
  // writing it, so by the time the async fs event this method responds to
  // is actually processed, `this.manifest` already matches what's on disk —
  // the diff below comes out empty and this is a no-op.
  private async handleManifestChange(): Promise<void> {
    if (!vscode.workspace.getConfiguration("tornado").get<boolean>("pushLocalParameterEdits", true)) {
      return;
    }

    const onDisk = await readManifest(this.appFolder);
    if (
      !onDisk ||
      !Array.isArray(onDisk.elements) ||
      typeof onDisk.appid !== "number" ||
      (onDisk.dataconnections !== undefined && !Array.isArray(onDisk.dataconnections))
    ) {
      this.output.appendLine(
        `${MANIFEST_FILENAME} could not be parsed or is missing required fields — ignoring this change, ` +
          "keeping the last known-good manifest in memory.",
      );
      return;
    }

    const diff = diffManifestParams(this.appid, this.manifest, onDisk, this.output);
    if (!diff) {
      // Identity check failed — diffManifestParams already logged why. Do
      // NOT adopt onDisk: this.manifest stays the last trustworthy state.
      return;
    }

    // Computed against the still-current this.manifest, before anything is
    // adopted — a removal has to be confirmed (or declined and restored)
    // before onDisk's copy becomes the source of truth below.
    const previousDataConnections = this.manifest.dataconnections;
    const dcDiff = diffManifestDataConnections(previousDataConnections, onDisk.dataconnections, this.output);
    let applyRemovals = true;
    if (dcDiff && this.hasDataConnectionRemovals(dcDiff)) {
      applyRemovals = await this.confirmDataConnectionRemovals(dcDiff, previousDataConnections);
      if (!applyRemovals) {
        this.restoreDeclinedRemovals(onDisk, previousDataConnections ?? [], dcDiff);
      }
    }

    // Adopt only once the identity check passed — mirrors reloadManifest()'s
    // unconditional-adopt semantics for the normal case. Adopting here
    // cannot itself trigger another change event for the appparams/
    // designparams path below, since nothing here calls writeManifestFile;
    // applyDataConnectionsDiff() does, when it needs to.
    this.manifest = onDisk;

    if (diff.appParams) {
      try {
        await this.client.updateApplicationParams(this.appid, diff.appParams);
        this.output.appendLine(`Pushed application parameters from ${MANIFEST_FILENAME}.`);
      } catch (error) {
        logError(
          this.output,
          `Failed to push application parameters from ${MANIFEST_FILENAME}: ${(error as Error).message}`,
        );
      }
    }
    for (const { entry, designparams } of diff.changedEntries) {
      try {
        await this.client.updateDesignParams(this.appid, entry.designbucketid, designparams);
        this.output.appendLine(`Pushed design parameters for "${entry.path}" from ${MANIFEST_FILENAME}.`);
      } catch (error) {
        logError(
          this.output,
          `Failed to push design parameters for "${entry.path}" from ${MANIFEST_FILENAME}: ${(error as Error).message}`,
        );
      }
    }

    if (dcDiff) {
      await this.applyDataConnectionsDiff(dcDiff, applyRemovals);
    }
  }

  private hasDataConnectionRemovals(diff: ManifestDataConnectionsDiff): boolean {
    return (
      diff.removedConnections.length > 0 ||
      diff.removedTables.length > 0 ||
      diff.tableChanges.some((change) => change.removedColumnIds.length > 0)
    );
  }

  // One modal for the whole batch, describing every deletion this manifest
  // change would cause (including what a connection/table removal cascades
  // into) — the same "confirm before anything destructive" precedent as
  // handleDelete()'s per-file dialog, batched here since a single manifest
  // save can remove several things at once.
  private async confirmDataConnectionRemovals(
    diff: ManifestDataConnectionsDiff,
    previous: ManifestDataConnection[] | undefined,
  ): Promise<boolean> {
    const prevByDbId = new Map((previous ?? []).map((connection) => [connection.dbconnectionid, connection]));
    const lines: string[] = [];
    for (const removed of diff.removedConnections) {
      const connection = prevByDbId.get(removed.dbconnectionid);
      const tableCount = connection?.tables.length ?? 0;
      const columnCount = connection?.tables.reduce((n, table) => n + table.columns.length, 0) ?? 0;
      lines.push(
        `- data connection "${removed.connectionname}" (cascades: ${tableCount} table(s), ${columnCount} column(s))`,
      );
    }
    for (const removed of diff.removedTables) {
      const connection = prevByDbId.get(removed.dbconnectionid);
      const table = connection?.tables.find((t) => t.tableid === removed.tableid);
      lines.push(
        `- table "${removed.tablename}" from connection "${connection?.connectionname ?? removed.dbconnectionid}" ` +
          `(cascades: ${table?.columns.length ?? 0} column(s))`,
      );
    }
    for (const change of diff.tableChanges) {
      if (change.removedColumnIds.length === 0) {
        continue;
      }
      const connection = prevByDbId.get(change.dbconnectionid);
      const table = connection?.tables.find((t) => t.tableid === change.tableid);
      const columnNames = change.removedColumnIds
        .map((id) => table?.columns.find((c) => c.attributeid === id)?.attributename ?? String(id))
        .join(", ");
      lines.push(`- column(s) ${columnNames} from table "${table?.tablename ?? change.tableid}"`);
    }

    const confirmAction = "Delete from Server";
    const confirmed = await vscode.window.showWarningMessage(
      `${MANIFEST_FILENAME} removed the following — delete them from the Tornado server too? This cannot be ` +
        `undone.\n\n${lines.join("\n")}`,
      { modal: true },
      confirmAction,
    );
    return confirmed === confirmAction;
  }

  // Splices every declined removal back into `onDisk` (about to become
  // this.manifest) using the full old objects from `previous` — the server
  // still has them, so the local manifest must too, or the next edit would
  // see them as "new" and try to recreate them.
  private restoreDeclinedRemovals(
    onDisk: Manifest,
    previous: ManifestDataConnection[],
    diff: ManifestDataConnectionsDiff,
  ): void {
    if (!onDisk.dataconnections) {
      return;
    }
    const prevByDbId = new Map(previous.map((connection) => [connection.dbconnectionid, connection]));
    const nextByDbId = new Map(onDisk.dataconnections.map((connection) => [connection.dbconnectionid, connection]));

    for (const removed of diff.removedConnections) {
      const connection = prevByDbId.get(removed.dbconnectionid);
      if (connection) {
        onDisk.dataconnections.push(connection);
      }
    }
    for (const removed of diff.removedTables) {
      const connection = nextByDbId.get(removed.dbconnectionid);
      const table = prevByDbId.get(removed.dbconnectionid)?.tables.find((t) => t.tableid === removed.tableid);
      if (connection && table) {
        connection.tables.push(table);
      }
    }
    for (const change of diff.tableChanges) {
      if (change.removedColumnIds.length === 0) {
        continue;
      }
      const table = nextByDbId.get(change.dbconnectionid)?.tables.find((t) => t.tableid === change.tableid);
      const oldTable = prevByDbId.get(change.dbconnectionid)?.tables.find((t) => t.tableid === change.tableid);
      if (!table || !oldTable) {
        continue;
      }
      for (const attributeid of change.removedColumnIds) {
        const column = oldTable.columns.find((c) => c.attributeid === attributeid);
        if (column) {
          table.columns.push(column);
        }
      }
    }
    this.output.appendLine(
      `Kept the above on the server (${MANIFEST_FILENAME} restored to match) — remove them again and confirm ` +
        "to actually delete them.",
    );
  }

  // Pushes every create/update diffManifestDataConnections() found, and —
  // when applyRemovals is true — every deletion too. A new table/column's
  // server-assigned id is written back into the object diffManifestDataConnections
  // returned, which is the same object living inside this.manifest, so a
  // create never repeats itself on the next save; persisted once at the end
  // if anything needs writing back (a new id, or a declined-removal restore
  // already applied to this.manifest by the caller).
  private async applyDataConnectionsDiff(diff: ManifestDataConnectionsDiff, applyRemovals: boolean): Promise<void> {
    // restoreDeclinedRemovals() already spliced any declined removal (a
    // connection, a table, or a column) back into this.manifest in memory —
    // this just needs to know whether that happened, so it gets written to
    // disk too. Same predicate that gated the confirmation modal, so it
    // can't drift out of sync with what was actually restored.
    let needsPersist = !applyRemovals && this.hasDataConnectionRemovals(diff);

    for (const change of diff.connectionChanges) {
      try {
        await this.client.updateDataConnection(this.appid, change.dbconnectionid, {
          connectionname: change.connectionname,
          databasename: change.databasename,
          comment: change.comment,
        });
        this.output.appendLine(`Pushed data connection "${change.connectionname}" from ${MANIFEST_FILENAME}.`);
      } catch (error) {
        logError(
          this.output,
          `Failed to push data connection "${change.connectionname}" from ${MANIFEST_FILENAME}: ` +
            `${(error as Error).message}`,
        );
      }
    }

    for (const { dbconnectionid, table } of diff.newTables) {
      try {
        const created = await this.client.createTable(this.appid, dbconnectionid, tablePayload(table));
        table.tableid = created.tableid;
        needsPersist = true;
        this.output.appendLine(`Created table "${table.tablename}" on the server (id ${created.tableid}).`);
        for (const column of table.columns) {
          try {
            const createdColumn = await this.client.createColumn(
              this.appid,
              dbconnectionid,
              created.tableid,
              columnPayload(column),
            );
            column.attributeid = createdColumn.attributeid;
            this.output.appendLine(
              `Created column "${column.attributename}" on the server (id ${createdColumn.attributeid}).`,
            );
          } catch (error) {
            logError(
              this.output,
              `Failed to create column "${column.attributename}" on table "${table.tablename}": ` +
                `${(error as Error).message}`,
            );
          }
        }
      } catch (error) {
        logError(
          this.output,
          `Failed to create table "${table.tablename}" from ${MANIFEST_FILENAME}: ${(error as Error).message}`,
        );
      }
    }

    for (const change of diff.tableChanges) {
      if (change.fields) {
        try {
          await this.client.updateTable(this.appid, change.dbconnectionid, change.tableid, change.fields);
          this.output.appendLine(`Pushed table "${change.fields.tablename}" from ${MANIFEST_FILENAME}.`);
        } catch (error) {
          logError(
            this.output,
            `Failed to push table ${change.tableid} from ${MANIFEST_FILENAME}: ${(error as Error).message}`,
          );
        }
      }
      for (const column of change.newColumns) {
        try {
          const created = await this.client.createColumn(
            this.appid,
            change.dbconnectionid,
            change.tableid,
            columnPayload(column),
          );
          column.attributeid = created.attributeid;
          needsPersist = true;
          this.output.appendLine(
            `Created column "${column.attributename}" on the server (id ${created.attributeid}).`,
          );
        } catch (error) {
          logError(
            this.output,
            `Failed to create column "${column.attributename}" on table ${change.tableid}: ${(error as Error).message}`,
          );
        }
      }
      for (const column of change.changedColumns) {
        try {
          await this.client.updateColumn(
            this.appid,
            change.dbconnectionid,
            change.tableid,
            column.attributeid,
            columnPayload(column),
          );
          this.output.appendLine(`Pushed column "${column.attributename}" from ${MANIFEST_FILENAME}.`);
        } catch (error) {
          logError(
            this.output,
            `Failed to push column "${column.attributename}" from ${MANIFEST_FILENAME}: ${(error as Error).message}`,
          );
        }
      }
      if (applyRemovals) {
        for (const attributeid of change.removedColumnIds) {
          try {
            await this.client.deleteColumn(this.appid, change.dbconnectionid, change.tableid, attributeid);
            this.output.appendLine(`Deleted column ${attributeid} from the server.`);
          } catch (error) {
            logError(
              this.output,
              `Failed to delete column ${attributeid} from the server: ${(error as Error).message}`,
            );
          }
        }
      }
    }

    if (applyRemovals) {
      for (const removed of diff.removedTables) {
        try {
          await this.client.deleteTable(this.appid, removed.dbconnectionid, removed.tableid);
          this.output.appendLine(`Deleted table "${removed.tablename}" from the server.`);
        } catch (error) {
          logError(
            this.output,
            `Failed to delete table "${removed.tablename}" from the server: ${(error as Error).message}`,
          );
        }
      }
      for (const removed of diff.removedConnections) {
        try {
          await this.client.deleteDataConnection(this.appid, removed.dbconnectionid);
          this.output.appendLine(`Deleted data connection "${removed.connectionname}" from the server.`);
        } catch (error) {
          logError(
            this.output,
            `Failed to delete data connection "${removed.connectionname}" from the server: ${(error as Error).message}`,
          );
        }
      }
    }

    if (needsPersist) {
      await this.persistManifest();
    }
  }

  private async handleDelete(uri: vscode.Uri): Promise<void> {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath || relativePath === MANIFEST_FILENAME) {
      return;
    }
    const entry = this.findEntry(relativePath);
    if (!entry) {
      return;
    }

    // The file is already gone locally by the time this event fires — the
    // only thing left to confirm is whether the server-side element should
    // go too.
    const confirmAction = "Delete from Server";
    const confirmed = await vscode.window.showWarningMessage(
      `"${relativePath}" was deleted locally. Also delete "${entry.name}" from the Tornado server? ` +
        "This cannot be undone.",
      { modal: true },
      confirmAction,
    );
    if (confirmed !== confirmAction) {
      this.output.appendLine(`Kept "${entry.name}" on the server (local file deleted, server unchanged).`);
      return;
    }

    try {
      await this.client.deleteDesignElement(this.appid, entry.designbucketid);
      this.manifest.elements = this.manifest.elements.filter((e) => e.path !== relativePath);
      await this.persistManifest();
      this.output.appendLine(`Deleted "${entry.name}" from the server.`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to delete "${entry.name}" from the Tornado server: ${(error as Error).message}`,
      );
    }
  }
}
