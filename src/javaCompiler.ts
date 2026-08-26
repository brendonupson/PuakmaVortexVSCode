import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TornadoClient } from "./tornadoClient";
import {
  AGENT_INSTRUCTION_FILENAMES,
  DEV_CONFIG_RELATIVE_PATH,
  JAR_CONTENT_TYPE,
  readDevConfig,
  readManifest,
} from "./designSync";
import { logError } from "./logging";

const execFileAsync = promisify(execFile);

// Actions/SharedCode/ScheduledActions can reference each other, so they're
// compiled together in one invocation rather than per-file — matches how
// the reference tool (vortex-cli-mirror's compile.py) does it, for the
// same reason.
export const JAVA_SOURCE_FOLDERS = ["Actions", "SharedCode", "ScheduledActions"];

// A single -d flag needs one shared output root regardless of which of the
// three folders a source came from — so compiled classes land here, not
// next to their .java. This is also why the watcher never needs to know
// about it: "zbin" isn't a recognised design-type folder, so it's silently
// skipped by handleCreate's existing unrecognised-folder check.
export const COMPILE_OUTPUT_FOLDER = "zbin";

const SERVER_LIB_FOLDER = ".lib"; // sits alongside app folders, directly under tornado/
const SYSTEM_JAR_FILENAME = "puakma.jar";
const LIBRARIES_ZIP_FILENAME = "libraries.zip";
const LIBRARIES_EXTRACT_FOLDER = "libraries";

// Compiling with ecj (the Eclipse Compiler for Java — literally the
// compiler Eclipse's own IDE runs internally) rather than javac: with
// -proceedOnError it keeps generating .class output for everything else
// even when a source has real errors, or an entirely unresolved import,
// embedding a stub that only throws at runtime if the broken part is
// actually reached — recreating the "keep working despite errors" model
// Eclipse workspaces have. javac instead sometimes discards output for the
// *whole* batch over one broken file (confirmed empirically — an
// unresolved import is enough), which previously needed an exclude-and-
// retry workaround; ecj's own error recovery makes that unnecessary.
// Pinned to a known-good version rather than "latest" for reproducibility,
// downloaded once from Maven Central (EPL-licensed, fine to fetch
// directly) into the extension's cross-workspace global storage, since
// it's a dev tool, not tied to any one server connection or workspace.
const ECJ_VERSION = "3.46.0";
const ECJ_JAR_FILENAME = `ecj-${ECJ_VERSION}.jar`;
const ECJ_DOWNLOAD_URL = `https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/${ECJ_VERSION}/${ECJ_JAR_FILENAME}`;

function findJava(): string {
  const configured = vscode.workspace.getConfiguration("tornado").get<string>("javaHome", "");
  const javaHome = configured || process.env.JAVA_HOME;
  if (javaHome) {
    return path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  }
  // Resolved via PATH by execFile if not found via a configured/env JAVA_HOME.
  return "java";
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function findJarsRecursive(dir: vscode.Uri): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(dir, name);
    if (type === vscode.FileType.Directory) {
      results.push(...(await findJarsRecursive(childUri)));
    } else if (type === vscode.FileType.File && name.endsWith(".jar")) {
      results.push(childUri.fsPath);
    }
  }
  return results;
}

// A SharedCode element with contenttype application/java-archive doesn't
// always end up with a .jar extension on disk — e.g. a name containing "$"
// gets written as "<name>.class" instead (see isNestedJavaClassName in
// designSync.ts), a jar contenttype under a non-bare-name designtype keeps
// whatever extension its name already had, or none. The manifest's
// contenttype field is the only reliable signal, so it's consulted first;
// the plain .jar filesystem scan stays as a fallback for jars not (yet)
// reflected there — a pre-manifest sync, or one manually dropped in.
export async function findSharedCodeJars(appFolder: vscode.Uri): Promise<string[]> {
  const manifest = await readManifest(appFolder);
  const jarPaths = new Set(
    (manifest?.elements ?? [])
      .filter((element) => element.contenttype.trim().toLowerCase() === JAR_CONTENT_TYPE)
      .map((element) => vscode.Uri.joinPath(appFolder, element.path).fsPath),
  );
  for (const fsPath of await findJarsRecursive(vscode.Uri.joinPath(appFolder, "SharedCode"))) {
    jarPaths.add(fsPath);
  }
  return [...jarPaths];
}

async function extractLibrariesZip(zipUri: vscode.Uri, destDir: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(destDir);
  try {
    // The zip's members are jar files themselves, not classes — javac can
    // treat a single jar/zip as a classpath entry, but not a zip-of-jars,
    // so this has to actually unpack. Shells out to the system "unzip"
    // rather than hand-rolling a zip reader or adding a dependency for it.
    await execFileAsync("unzip", ["-o", zipUri.fsPath, "-d", destDir.fsPath]);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `Could not find "unzip" to extract the server's ${LIBRARIES_ZIP_FILENAME}. Extract it ` +
          `manually into "${destDir.fsPath}" and try compiling again.`,
      );
    }
    throw new Error(`Failed to extract ${LIBRARIES_ZIP_FILENAME}: ${(error as Error).message}`);
  }
}

// A CLAUDE.md/AGENTS.md sitting at the root of the shared libraries zip is
// guidance for AI coding assistants, not a jar — mirrored into each app
// folder so it's visible alongside the app's own code, whichever agent the
// user has. This is a one-way copy, not a design element: re-run on every
// ensureServerLibraries call (not just when the zip is freshly unzipped) so
// every app stays in sync with the shared copy, silently overwriting any
// local edits. That's intentional — the watcher never uploads either file
// (see appWatcher.ts), so a local edit has nowhere to go and isn't preserved.
async function copyAgentInstructionFiles(
  librariesDir: vscode.Uri,
  appFolder: vscode.Uri,
  output: vscode.OutputChannel,
): Promise<void> {
  for (const filename of AGENT_INSTRUCTION_FILENAMES) {
    const source = vscode.Uri.joinPath(librariesDir, filename);
    if (!(await exists(source))) {
      continue;
    }
    const dest = vscode.Uri.joinPath(appFolder, filename);
    await vscode.workspace.fs.copy(source, dest, { overwrite: true });
    output.appendLine(`  copied ${filename} from shared libraries into ${appFolder.fsPath}`);
  }
}

// Downloads (or reuses a locally cached copy of) the server's own
// puakma.jar and shared-library jars via GET /vortex/systemjar and
// GET /vortex/libraries, so Java design elements are compiled against
// exactly the classes the server runs. Cached per-connection under
// tornado/.lib/<connectionId>/, since these are server-wide rather than
// per-app. Pass forceRefresh after a server-side upgrade to re-download.
export async function ensureServerLibraries(
  tornadoRoot: vscode.Uri,
  appFolder: vscode.Uri,
  connectionId: string,
  client: TornadoClient,
  output: vscode.OutputChannel,
  forceRefresh = false,
): Promise<string[]> {
  const libDir = vscode.Uri.joinPath(tornadoRoot, SERVER_LIB_FOLDER, connectionId);
  await vscode.workspace.fs.createDirectory(libDir);

  const systemJarUri = vscode.Uri.joinPath(libDir, SYSTEM_JAR_FILENAME);
  if (forceRefresh || !(await exists(systemJarUri))) {
    output.appendLine("Downloading puakma.jar from the server (GET /vortex/systemjar)...");
    const bytes = await client.downloadSystemJar();
    await vscode.workspace.fs.writeFile(systemJarUri, new Uint8Array(bytes));
    output.appendLine(`  saved ${systemJarUri.fsPath}`);
  }

  const librariesZipUri = vscode.Uri.joinPath(libDir, LIBRARIES_ZIP_FILENAME);
  const librariesDir = vscode.Uri.joinPath(libDir, LIBRARIES_EXTRACT_FOLDER);
  let libraryJars = await findJarsRecursive(librariesDir);
  if (forceRefresh || !(await exists(librariesZipUri)) || libraryJars.length === 0) {
    output.appendLine("Downloading shared libraries from the server (GET /vortex/libraries)...");
    const bytes = await client.downloadLibraries();
    await vscode.workspace.fs.writeFile(librariesZipUri, new Uint8Array(bytes));
    output.appendLine(`  saved ${librariesZipUri.fsPath}, extracting...`);
    await extractLibrariesZip(librariesZipUri, librariesDir);
    libraryJars = await findJarsRecursive(librariesDir);
    output.appendLine(`  ${libraryJars.length} jar(s) extracted`);
  }

  await copyAgentInstructionFiles(librariesDir, appFolder, output);

  return [systemJarUri.fsPath, ...libraryJars];
}

// Downloads (or reuses a cached copy of) the ecj batch compiler jar into
// the extension's global storage — shared across every workspace and app,
// since it's a dev tool rather than something server- or app-specific.
export async function ensureEcj(globalStorageUri: vscode.Uri, output: vscode.OutputChannel): Promise<string> {
  const jarUri = vscode.Uri.joinPath(globalStorageUri, "ecj", ECJ_JAR_FILENAME);
  if (await exists(jarUri)) {
    return jarUri.fsPath;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(globalStorageUri, "ecj"));
  output.appendLine(`Downloading the Eclipse Compiler for Java (ecj ${ECJ_VERSION})...`);
  const response = await fetch(ECJ_DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Failed to download ecj from ${ECJ_DOWNLOAD_URL}: ${response.status} ${response.statusText}`);
  }
  const bytes = await response.arrayBuffer();
  await vscode.workspace.fs.writeFile(jarUri, new Uint8Array(bytes));
  output.appendLine(`  saved ${jarUri.fsPath} (${bytes.byteLength} bytes)`);
  return jarUri.fsPath;
}

export interface CompileResult {
  classFiles: vscode.Uri[]; // top-level only — one per compiled source, matched to its design element by name
  nestedClassFiles: vscode.Uri[]; // nested/inner/anonymous classes (e.g. Foo$Bar.class) — no source maps to these, so they're uploaded as SharedCode design elements instead, created on the server the first time each one is seen (see compileAndUploadFolder)
  hadErrors: boolean; // true if ecj reported errors — classFiles may still include stub classes for the affected sources (see compileApp)
  failedSourceNames: string[]; // base names (no extension) of sources that produced no class at all, even as a stub
  sourceFiles: string[]; // every .java fsPath in this batch — paired with erroredSourceFiles to badge the Explorer (see JavaCompileStatusProvider)
  erroredSourceFiles: string[]; // fsPaths (of sourceFiles) ecj reported an error against, including ones in failedSourceNames
}

// ecj's batch-compile diagnostics list each problem as
// "<n>. ERROR in <path> (at line <n>)" (or WARNING) — parsed here to
// attribute errors back to the specific source that has them, since
// hadErrors above only says the batch as a whole had a problem somewhere.
// This is ecj's plain-text output format, not a stable contract, but the
// version is pinned above so it isn't going to shift under us.
function parseErrorSourcePaths(output: string): Set<string> {
  const paths = new Set<string>();
  const regex = /^\d+\.\s+ERROR in (.+?)(?:\s*\(at line \d+\))?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output))) {
    paths.add(match[1].trim());
  }
  return paths;
}

export async function compileApp(
  appFolder: vscode.Uri,
  connectionId: string,
  client: TornadoClient,
  globalStorageUri: vscode.Uri,
  output: vscode.OutputChannel,
): Promise<CompileResult | undefined> {
  const sourceFiles: string[] = [];
  for (const folder of JAVA_SOURCE_FOLDERS) {
    const dirUri = vscode.Uri.joinPath(appFolder, folder);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && name.endsWith(".java")) {
        sourceFiles.push(vscode.Uri.joinPath(dirUri, name).fsPath);
      }
    }
  }
  if (sourceFiles.length === 0) {
    output.appendLine("No .java sources found to compile.");
    return undefined;
  }

  // appFolder is tornado/<connectionName>_<appgroup>_<appname>/, so its
  // parent is tornado/ itself — where the shared per-connection lib cache
  // lives, alongside (not inside) any particular app's folder.
  const tornadoRoot = vscode.Uri.joinPath(appFolder, "..");
  const serverClasspath = await ensureServerLibraries(tornadoRoot, appFolder, connectionId, client, output);
  const sharedCodeJars = await findSharedCodeJars(appFolder);
  const extraClasspath = vscode.workspace.getConfiguration("tornado").get<string[]>("compileClasspath", []);
  const classpath = [...serverClasspath, ...sharedCodeJars, ...extraClasspath];

  const outDir = vscode.Uri.joinPath(appFolder, COMPILE_OUTPUT_FOLDER);
  // Cleared before every run rather than just created-if-missing: javac
  // doesn't delete a source's old .class output just because recompiling
  // that source failed this time, so a stale outDir could otherwise leave
  // last run's class sitting there and get mistaken for a fresh success —
  // uploading unchanged bytecode for a source that's now actually broken.
  try {
    await vscode.workspace.fs.delete(outDir, { recursive: true, useTrash: false });
  } catch {
    // Didn't exist yet — fine, this is the first compile of this app.
  }
  await vscode.workspace.fs.createDirectory(outDir);

  // Documentation/devconfig.json (created on sync, see designSync.ts) is the
  // per-app override — falls back to the global setting if it's missing or
  // doesn't specify one.
  const devConfig = await readDevConfig(appFolder);
  const release =
    devConfig?.javaVersion ||
    vscode.workspace.getConfiguration("tornado").get<string>("javaRelease", "8");
  if (devConfig?.javaVersion) {
    output.appendLine(`Using javaVersion "${devConfig.javaVersion}" from ${DEV_CONFIG_RELATIVE_PATH}.`);
  }
  const ecjJar = await ensureEcj(globalStorageUri, output);
  const java = findJava();
  const args = [
    "-jar",
    ecjJar,
    "-d",
    outDir.fsPath,
    "-cp",
    classpath.join(path.delimiter),
    "--release",
    release,
    "-proceedOnError",
    ...sourceFiles,
  ];

  output.appendLine(`→ ${java} ${args.join(" ")}`);
  let hadErrors = false;
  let combinedOutput = "";
  try {
    const { stdout, stderr } = await execFileAsync(java, args);
    combinedOutput = `${stdout}\n${stderr}`;
    if (stdout.trim()) {
      output.appendLine(stdout);
    }
    if (stderr.trim()) {
      output.appendLine(stderr);
    }
  } catch (error) {
    // ecj exited non-zero: whatever it printed is a compile diagnostic, so
    // it's logged in red rather than mixed in with the ordinary progress.
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    combinedOutput = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    if (err.stdout?.trim()) {
      logError(output, err.stdout);
    }
    if (err.stderr?.trim()) {
      logError(output, err.stderr);
    }
    if (err.code === "ENOENT") {
      throw new Error(
        `Could not find java ("${java}"). Set "tornado.javaHome" to a JDK's home directory, ` +
          'ensure $JAVA_HOME is set, or make sure "java" is on your PATH.',
      );
    }
    // -proceedOnError means ecj still writes .class output (with a
    // runtime-throwing stub in place of whatever's actually broken) for
    // every source it can, rather than discarding the whole batch's output
    // the way javac can over a single unresolved import — a non-zero exit
    // here just means errors were reported, not that nothing compiled.
    // What's actually sitting in outDir below reflects that.
    hadErrors = true;
    output.appendLine(
      "ecj reported errors (above) — proceeding anyway (-proceedOnError): the class(es) for the " +
        "affected source(s) may throw at runtime if the broken part is actually reached.",
    );
  }
  const erroredSourceFiles = parseErrorSourcePaths(combinedOutput);

  const compiled = await vscode.workspace.fs.readDirectory(outDir);
  const classFiles: vscode.Uri[] = [];
  const nestedClassFiles: vscode.Uri[] = [];
  for (const [name, type] of compiled) {
    if (type !== vscode.FileType.File || !name.endsWith(".class")) {
      continue;
    }
    if (name.includes("$")) {
      // Nested/inner/anonymous classes — no .java source of their own to
      // match a design element by name, so they're uploaded separately as
      // SharedCode design elements (see compileAndUploadFolder).
      nestedClassFiles.push(vscode.Uri.joinPath(outDir, name));
      continue;
    }
    classFiles.push(vscode.Uri.joinPath(outDir, name));
  }
  if (nestedClassFiles.length > 0) {
    output.appendLine(
      `${nestedClassFiles.length} nested/inner/anonymous class(es) compiled — will be uploaded as ` +
        "SharedCode design element(s).",
    );
  }

  const compiledNames = new Set(classFiles.map((uri) => path.basename(uri.fsPath, ".class")));
  const failedSourceNames = sourceFiles
    .map((file) => path.basename(file, ".java"))
    .filter((name) => !compiledNames.has(name));
  // A source with no output at all is definitely broken even though ecj
  // never got the chance to print an "ERROR in <path>" line for it (e.g. a
  // file so malformed it can't be parsed at all).
  for (const file of sourceFiles) {
    if (failedSourceNames.includes(path.basename(file, ".java"))) {
      erroredSourceFiles.add(file);
    }
  }

  output.appendLine(
    `Compiled ${classFiles.length} top-level class(es)` +
      (failedSourceNames.length > 0
        ? `, ${failedSourceNames.length} produced no output at all (not even a stub): ${failedSourceNames.join(", ")}`
        : "") +
      ".",
  );
  return {
    classFiles,
    nestedClassFiles,
    hadErrors,
    failedSourceNames,
    sourceFiles,
    erroredSourceFiles: [...erroredSourceFiles],
  };
}
