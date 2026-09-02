import * as vscode from "vscode";
import * as path from "node:path";
import { JAVA_SOURCE_FOLDERS, findSharedCodeJars } from "./javaCompiler";

const REFERENCED_LIBRARIES_KEY = "project.referencedLibraries";
const SOURCE_PATHS_KEY = "project.sourcePaths";
const LIB_GLOB = "tornado/.lib/**/*.jar";
// The sync root was ".tornado/" (hidden) before it was renamed to visible
// "tornado/" pre-0.0.1 (see cb310f5) — this old glob never matches anything
// post-rename, but the merge-only-add logic below never removed it from
// workspaces that picked it up before the rename, so it's pruned on sight.
const OBSOLETE_LIB_GLOB = ".tornado/.lib/**/*.jar";
const JAVA_EXTENSION_ID = "redhat.java";

type ReferencedLibraries =
  | string[]
  | { include?: string[]; exclude?: string[]; sources?: Record<string, string> };

// Merges `entries` into java.project.referencedLibraries (skipping ones
// already present) and drops any of `stale` found there. Returns true if
// the setting was actually changed.
async function updateReferencedLibraries(
  config: vscode.WorkspaceConfiguration,
  entries: string[],
  stale: string[],
): Promise<boolean> {
  const current = config.inspect<ReferencedLibraries>(REFERENCED_LIBRARIES_KEY)?.workspaceValue;
  const currentList = Array.isArray(current) ? current : (current?.include ?? []);

  const pruned = currentList.filter((e) => !stale.includes(e));
  const missing = entries.filter((e) => !pruned.includes(e));
  if (missing.length === 0 && pruned.length === currentList.length) {
    return false;
  }
  const merged = [...pruned, ...missing];

  const updated: ReferencedLibraries =
    current && !Array.isArray(current) ? { ...current, include: merged } : merged;
  await config.update(REFERENCED_LIBRARIES_KEY, updated, vscode.ConfigurationTarget.Workspace);
  return true;
}

// Actions/SharedCode/ScheduledActions can reference each other (see
// JAVA_SOURCE_FOLDERS in javaCompiler.ts), but with no pom.xml/.classpath
// backing an app folder, the Java language server otherwise has to guess
// they belong to the same "invisible project" via its own heuristics —
// fragile because apps sit nested (tornado/<app>/Actions, .../SharedCode)
// under a workspace root that can hold several sibling apps, so a static
// field in SharedCode can fail to resolve from an Action right after a
// fresh sync. Declaring java.project.sourcePaths explicitly removes the
// guesswork instead of waiting on that detection or a compile.
async function addSourcePaths(config: vscode.WorkspaceConfiguration, appFolder: vscode.Uri): Promise<boolean> {
  const relAppFolder = vscode.workspace.asRelativePath(appFolder, false);
  const newPaths = JAVA_SOURCE_FOLDERS.map((folder) => `${relAppFolder}/${folder}`);

  const current = config.inspect<string[]>(SOURCE_PATHS_KEY)?.workspaceValue ?? [];
  const missing = newPaths.filter((p) => !current.includes(p));
  if (missing.length === 0) {
    return false;
  }

  await config.update(SOURCE_PATHS_KEY, [...current, ...missing], vscode.ConfigurationTarget.Workspace);
  return true;
}

// Points VS Code's Java language server (redhat.java) at the downloaded
// server jars and at this app's own source folders, so Actions/SharedCode/
// ScheduledActions resolve both framework types like ActionRunner and each
// other's own classes instead of showing "cannot be resolved to a type" —
// these are loose files with no Maven/Gradle/Eclipse project backing them,
// so the language server has no classpath or project shape for them at all
// without these settings (this is separate from, and doesn't affect, the
// actual javac compile classpath in javaCompiler.ts).
//
// Both REFERENCED_LIBRARIES_KEY and SOURCE_PATHS_KEY are declared
// "scope": "window" by redhat.java itself — VS Code only allows one shared
// value per window, never one per app folder — and entries are only ever
// merged in here, removed solely by removeJavaIntelliSense() on "Close
// Application". So with more than one app synced/compiled in the same
// window and not explicitly closed, redhat.java treats all of them as one
// shared project: a name collision between two open apps' classes can
// resolve to the wrong one. Not fixable from this side; see the "Java
// editor IntelliSense" note in README.md.
//
// Returns true if a workspace setting was just added/changed (the Java
// language server can need a reload or "Clean Workspace" to pick that up).
export async function ensureJavaIntelliSense(
  output: vscode.OutputChannel,
  appFolder: vscode.Uri,
): Promise<boolean> {
  if (!vscode.extensions.getExtension(JAVA_EXTENSION_ID)) {
    output.appendLine(
      `"${JAVA_EXTENSION_ID}" (Language Support for Java) isn't installed — install it for Java ` +
        "IntelliSense (type resolution, completion) in Actions/SharedCode/ScheduledActions.",
    );
    return false;
  }

  const config = vscode.workspace.getConfiguration("java");
  // The glob only ever reaches tornado/.lib/ — a jar dropped directly in an
  // app's own SharedCode/ (see findSharedCodeJars in javaCompiler.ts, which
  // also feeds the actual compile classpath) needs its own explicit entry,
  // since it lives outside that glob's reach.
  const sharedCodeJars = await findSharedCodeJars(appFolder);
  const librariesChanged = await updateReferencedLibraries(
    config,
    [LIB_GLOB, ...sharedCodeJars],
    [OBSOLETE_LIB_GLOB],
  );
  if (librariesChanged) {
    output.appendLine(
      "Updated java.project.referencedLibraries (workspace settings) with the server jar glob" +
        (sharedCodeJars.length > 0 ? ` and ${sharedCodeJars.length} SharedCode jar(s)` : "") +
        ".",
    );
  }
  const sourcePathsChanged = await addSourcePaths(config, appFolder);
  if (sourcePathsChanged) {
    output.appendLine(`Added ${appFolder.fsPath}'s source folders to java.project.sourcePaths (workspace settings).`);
  }
  return librariesChanged || sourcePathsChanged;
}

// Reverses ensureJavaIntelliSense for one app folder — used by "Close
// Application" so java.project.sourcePaths/referencedLibraries don't keep
// stale entries pointing at a folder that's about to stop existing. Only
// removes entries scoped to this app (its own source folders, its own
// SharedCode jars); the shared tornado/.lib/**/*.jar glob — and the
// tornado/.lib/<connectionId>/ cache it points at — are left alone, since
// other still-open apps on the same connection depend on both.
export async function removeJavaIntelliSense(output: vscode.OutputChannel, appFolder: vscode.Uri): Promise<void> {
  if (!vscode.extensions.getExtension(JAVA_EXTENSION_ID)) {
    return;
  }
  const config = vscode.workspace.getConfiguration("java");

  const relPrefix = `${vscode.workspace.asRelativePath(appFolder, false)}/`;
  const currentSourcePaths = config.inspect<string[]>(SOURCE_PATHS_KEY)?.workspaceValue ?? [];
  const prunedSourcePaths = currentSourcePaths.filter((p) => !p.startsWith(relPrefix));
  if (prunedSourcePaths.length !== currentSourcePaths.length) {
    await config.update(SOURCE_PATHS_KEY, prunedSourcePaths, vscode.ConfigurationTarget.Workspace);
    output.appendLine(`Removed ${appFolder.fsPath}'s source folders from java.project.sourcePaths.`);
  }

  const absPrefix = appFolder.fsPath + path.sep;
  const current = config.inspect<ReferencedLibraries>(REFERENCED_LIBRARIES_KEY)?.workspaceValue;
  const currentList = Array.isArray(current) ? current : (current?.include ?? []);
  const prunedList = currentList.filter((e) => !e.startsWith(absPrefix));
  if (prunedList.length !== currentList.length) {
    const updated: ReferencedLibraries =
      current && !Array.isArray(current) ? { ...current, include: prunedList } : prunedList;
    await config.update(REFERENCED_LIBRARIES_KEY, updated, vscode.ConfigurationTarget.Workspace);
    output.appendLine(`Removed ${appFolder.fsPath}'s SharedCode jar(s) from java.project.referencedLibraries.`);
  }
}
