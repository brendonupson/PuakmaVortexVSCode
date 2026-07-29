import * as vscode from "vscode";
import {
  DesignElementPayload,
  NewDesignElementPayload,
  TornadoClient,
} from "./tornadoClient";
import {
  AGENT_INSTRUCTION_FILENAMES,
  DEV_CONFIG_RELATIVE_PATH,
  Manifest,
  ManifestEntry,
  MANIFEST_FILENAME,
  folderToDesignType,
  inferContentType,
  isJavaSourceUpload,
  serverNameFor,
  useSourceField,
  writeManifestFile,
} from "./designSync";

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
      this.output.appendLine(`Unexpected watcher error: ${message}`);
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
    if (
      !relativePath ||
      relativePath === MANIFEST_FILENAME ||
      relativePath === DEV_CONFIG_RELATIVE_PATH ||
      AGENT_INSTRUCTION_FILENAMES.includes(relativePath) ||
      this.findEntry(relativePath)
    ) {
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
    if (
      !relativePath ||
      relativePath === MANIFEST_FILENAME ||
      AGENT_INSTRUCTION_FILENAMES.includes(relativePath)
    ) {
      return;
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
