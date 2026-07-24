import * as vscode from "vscode";

const REFERENCED_LIBRARIES_KEY = "project.referencedLibraries";
const LIB_GLOB = ".tornado/.lib/**/*.jar";
const JAVA_EXTENSION_ID = "redhat.java";

type ReferencedLibraries =
  | string[]
  | { include?: string[]; exclude?: string[]; sources?: Record<string, string> };

// Points VS Code's Java language server (redhat.java) at the downloaded
// server jars, so Actions/SharedCode/ScheduledActions resolve framework
// types like ActionRunner instead of showing "cannot be resolved to a
// type" — these are loose files with no Maven/Gradle/Eclipse project
// backing them, so the language server has no classpath for them at all
// without this setting (this is separate from, and doesn't affect, the
// actual javac compile classpath in javaCompiler.ts).
//
// Returns true if the workspace setting was just added/changed (the Java
// language server can need a reload or "Clean Workspace" to pick that up).
export async function ensureJavaIntelliSense(output: vscode.OutputChannel): Promise<boolean> {
  if (!vscode.extensions.getExtension(JAVA_EXTENSION_ID)) {
    output.appendLine(
      `"${JAVA_EXTENSION_ID}" (Language Support for Java) isn't installed — install it for Java ` +
        "IntelliSense (type resolution, completion) in Actions/SharedCode/ScheduledActions.",
    );
    return false;
  }

  const config = vscode.workspace.getConfiguration("java");
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

  await config.update(REFERENCED_LIBRARIES_KEY, updated, vscode.ConfigurationTarget.Workspace);
  output.appendLine(`Added "${LIB_GLOB}" to java.project.referencedLibraries (workspace settings).`);
  return true;
}
