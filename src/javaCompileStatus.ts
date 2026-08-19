import * as vscode from "vscode";
import * as path from "node:path";

export type JavaCompileStatus = "ok" | "error";

// Badges Actions/SharedCode/ScheduledActions .java files in the native
// Explorer green or red after each compile, so a broken file is visible
// without opening it or checking the output channel. FileDecorationProvider
// applies to any file:// URI already shown in the Explorer, so this needs no
// dedicated tree view of its own — it decorates the same files the built-in
// Explorer already lists.
export class JavaCompileStatusProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly statuses = new Map<string, JavaCompileStatus>();
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = this.statuses.get(uri.fsPath);
    if (!status) {
      return undefined;
    }
    return status === "ok"
      ? { badge: "J", color: new vscode.ThemeColor("charts.green"), tooltip: "Tornado: compiled cleanly" }
      : {
          badge: "J",
          color: new vscode.ThemeColor("charts.red"),
          tooltip: "Tornado: compile error — see the Tornado output channel",
        };
  }

  // Called after every compile (the tornado.compileAndUpload command and
  // auto-compile-on-save both funnel through compileAndUploadFolder) with
  // every source that was part of the batch and the subset of those
  // (by fsPath) ecj reported errors for — see javaCompiler.ts's
  // erroredSourceFiles. Anything not in erroredFsPaths compiled cleanly.
  record(sourceFsPaths: readonly string[], erroredFsPaths: ReadonlySet<string>): void {
    const changed: vscode.Uri[] = [];
    for (const fsPath of sourceFsPaths) {
      const next: JavaCompileStatus = erroredFsPaths.has(fsPath) ? "error" : "ok";
      if (this.statuses.get(fsPath) !== next) {
        this.statuses.set(fsPath, next);
        changed.push(vscode.Uri.file(fsPath));
      }
    }
    if (changed.length > 0) {
      this._onDidChangeFileDecorations.fire(changed);
    }
  }

  // Called when an app folder is wiped and re-synced fresh, so a badge from
  // the old copy doesn't linger on a file that's about to be recreated (or
  // no longer exists) until the next compile.
  clearFolder(folder: vscode.Uri): void {
    const prefix = folder.fsPath + path.sep;
    const changed: vscode.Uri[] = [];
    for (const fsPath of this.statuses.keys()) {
      if (fsPath.startsWith(prefix)) {
        this.statuses.delete(fsPath);
        changed.push(vscode.Uri.file(fsPath));
      }
    }
    if (changed.length > 0) {
      this._onDidChangeFileDecorations.fire(changed);
    }
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
