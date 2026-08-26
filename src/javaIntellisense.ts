import * as vscode from "vscode";
import { JAVA_SOURCE_FOLDERS } from "./javaCompiler";

const REFERENCED_LIBRARIES_KEY = "project.referencedLibraries";
const SOURCE_PATHS_KEY = "project.sourcePaths";
const LIB_GLOB = "tornado/.lib/**/*.jar";
const JAVA_EXTENSION_ID = "redhat.java";

type ReferencedLibraries =
  | string[]
  | { include?: string[]; exclude?: string[]; sources?: Record<string, string> };

function addReferencedLibraries(config: vscode.WorkspaceConfiguration): boolean {
  const current = config.inspect<ReferencedLibraries>(REFERENCED_LIBRARIES_KEY)?.workspaceValue;

  let updated: ReferencedLibraries;
  if (Array.isArray(current)) {
    if (current.includes(LIB_GLOB)) {
      return false;
    }
    updated = [...current, LIB_GLOB];
  } else if (current && typeof current === "object") {
    const include = current.include ?? [];
    if (include.includes(LIB_GLOB)) {
      return false;
    }
    updated = { ...current, include: [...include, LIB_GLOB] };
  } else {
    updated = [LIB_GLOB];
  }

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
  const librariesChanged = addReferencedLibraries(config);
  if (librariesChanged) {
    output.appendLine(`Added "${LIB_GLOB}" to java.project.referencedLibraries (workspace settings).`);
  }
  const sourcePathsChanged = addSourcePaths(config, appFolder);
  if (sourcePathsChanged) {
    output.appendLine(`Added ${appFolder.fsPath}'s source folders to java.project.sourcePaths (workspace settings).`);
  }
  return librariesChanged || sourcePathsChanged;
}
