import * as vscode from "vscode";
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
function updateReferencedLibraries(
  config: vscode.WorkspaceConfiguration,
  entries: string[],
  stale: string[],
): boolean {
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
  void config.update(REFERENCED_LIBRARIES_KEY, updated, vscode.ConfigurationTarget.Workspace);
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
function addSourcePaths(config: vscode.WorkspaceConfiguration, appFolder: vscode.Uri): boolean {
  const relAppFolder = vscode.workspace.asRelativePath(appFolder, false);
  const newPaths = JAVA_SOURCE_FOLDERS.map((folder) => `${relAppFolder}/${folder}`);

  const current = config.inspect<string[]>(SOURCE_PATHS_KEY)?.workspaceValue ?? [];
  const missing = newPaths.filter((p) => !current.includes(p));
  if (missing.length === 0) {
    return false;
  }

  void config.update(SOURCE_PATHS_KEY, [...current, ...missing], vscode.ConfigurationTarget.Workspace);
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
  const librariesChanged = updateReferencedLibraries(config, [LIB_GLOB, ...sharedCodeJars], [OBSOLETE_LIB_GLOB]);
  if (librariesChanged) {
    output.appendLine(
      "Updated java.project.referencedLibraries (workspace settings) with the server jar glob" +
        (sharedCodeJars.length > 0 ? ` and ${sharedCodeJars.length} SharedCode jar(s)` : "") +
        ".",
    );
  }
  const sourcePathsChanged = addSourcePaths(config, appFolder);
  if (sourcePathsChanged) {
    output.appendLine(`Added ${appFolder.fsPath}'s source folders to java.project.sourcePaths (workspace settings).`);
  }
  return librariesChanged || sourcePathsChanged;
}
