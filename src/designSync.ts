import * as vscode from "vscode";
import { DesignElement, DesignParam } from "./tornadoClient";
import { assertSafePathSegment } from "./workspaceStorage";

const DESIGN_TYPE_FOLDERS: Record<number, string> = {
  1: "Pages",
  2: "Resources",
  3: "Actions",
  4: "SharedCode",
  5: "Documentation",
  6: "ScheduledActions",
  7: "Widgets",
};

const FOLDER_DESIGN_TYPES: Record<string, number> = Object.fromEntries(
  Object.entries(DESIGN_TYPE_FOLDERS).map(([type, folder]) => [folder, Number(type)]),
);

export function folderToDesignType(folder: string): number | undefined {
  return FOLDER_DESIGN_TYPES[folder];
}

export function designTypeFolder(designtype: number): string | undefined {
  return DESIGN_TYPE_FOLDERS[designtype];
}

// Design types whose elements have no editable parameters. The context-menu
// "when" clause for tornado.editDesignElementParameters in package.json
// spells out the *folders* of the types that do (Pages, Resources, Actions),
// since a when clause can only match on the path — keep the two in sync. The
// command itself re-checks with this, because the Command Palette route
// (which uses the active editor's file) never runs that clause.
const PARAMETERLESS_DESIGN_TYPES = new Set([
  4, // SharedCode
  5, // Documentation
  6, // ScheduledActions
  7, // Widgets
]);

export function supportsDesignParams(designtype: number): boolean {
  return !PARAMETERLESS_DESIGN_TYPES.has(designtype);
}

const PAGE_DESIGN_TYPE = 1;

// Only these three, per the Tornado application: Widgets are Java too in
// at least one other Tornado tool this was cross-checked against, but are
// deliberately left out here unless/until confirmed for this server.
const JAVA_SOURCE_DESIGN_TYPES = new Set([3, 4, 6]); // Actions, SharedCode, ScheduledActions

// Documentation also stores its content in designsource (not designdata),
// even though its extension isn't forced to .java like the set above.
const SOURCE_FIELD_DESIGN_TYPES = new Set([3, 4, 5, 6]);

const JAR_CONTENT_TYPE = "application/java-archive";
const JAVA_MIME_TYPES = new Set(["application/java", "application/octet-stream", "application/javavm"]);
const JAVA_CONTENT_TYPE = "application/java";

const MIME_EXTENSIONS: Record<string, string> = {
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/javascript": ".js",
  "text/xml": ".xml",
  "application/xml": ".xml",
  "text/xsl": ".xsl",
  "application/xslt+xml": ".xsl",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
};

// Fallback for content types not in the table above: derive a plausible
// extension from the MIME subtype (e.g. "image/webp" -> ".webp").
function guessExtension(contenttype: string): string {
  const subtype = contenttype.split("/")[1] ?? "";
  const cleaned = subtype.split(";")[0].split("+")[0].replace(/^x-/, "");
  return /^[a-z0-9.-]+$/.test(cleaned) ? `.${cleaned}` : "";
}

export function extensionFor(designtype: number, contenttype: string): string {
  const ctype = contenttype.trim().toLowerCase();
  if (ctype === JAR_CONTENT_TYPE) {
    return ".jar";
  }
  if (JAVA_SOURCE_DESIGN_TYPES.has(designtype) && JAVA_MIME_TYPES.has(ctype)) {
    return ".java";
  }
  if (designtype === PAGE_DESIGN_TYPE) {
    // Tornado pages mix in non-standard tags on top of HTML, so a plain
    // .html extension would mislead editors/tooling — use a distinct
    // extension that a custom editor could be associated with later.
    return ".phtml";
  }
  return MIME_EXTENSIONS[ctype] ?? guessExtension(ctype);
}

// Inverse of extensionFor(), used when a brand-new local file has to be
// turned into a contenttype for the server (no contenttype exists yet
// since there's no design element to have downloaded one from).
export function inferContentType(designtype: number, ext: string): string {
  const cleanExt = ext.toLowerCase();
  if (cleanExt === ".jar") {
    return JAR_CONTENT_TYPE;
  }
  if (JAVA_SOURCE_DESIGN_TYPES.has(designtype) && cleanExt === ".java") {
    return JAVA_CONTENT_TYPE;
  }
  if (designtype === PAGE_DESIGN_TYPE) {
    return "text/html";
  }
  for (const [mime, mappedExt] of Object.entries(MIME_EXTENSIONS)) {
    if (mappedExt === cleanExt) {
      return mime;
    }
  }
  // Safe generic fallback rather than guessing a text MIME type that might
  // corrupt binary content.
  return "application/octet-stream";
}

export function useSourceField(designtype: number, contenttype: string): boolean {
  if (contenttype.trim().toLowerCase() === JAR_CONTENT_TYPE) {
    // Jars can appear under SharedCode's designtype but always live in
    // designdata, never designsource.
    return false;
  }
  return SOURCE_FIELD_DESIGN_TYPES.has(designtype);
}

// Nested/inner/anonymous classes (e.g. "Foo$Bar") have no .java of their
// own — javaCompiler.ts uploads them with designsource left empty, since
// there's nothing to put there. Writing that empty designsource back out as
// a "Foo$Bar.java" on sync would hand ecj a real, compilable-looking source
// file with nothing in it, which it would then dutifully fail to compile on
// every run thereafter (see compileApp's sourceFiles enumeration, which
// picks up every .java under these folders). Written as a plain .class
// instead — bytecode only, never fed back into a compile.
export function isNestedJavaClassName(designtype: number, name: string): boolean {
  return JAVA_SOURCE_DESIGN_TYPES.has(designtype) && name.includes("$");
}

// Java source/class changes under Actions/SharedCode/ScheduledActions are
// handled exclusively by "Tornado: Compile & Upload Java" (javaCompiler.ts),
// not the generic per-file watcher — uploading designsource alone wouldn't
// take effect (designdata needs recompiled bytecode), and .class files are
// only ever meant to arrive via that command's own upload step, even if one
// turns up directly inside one of these folders instead of in zbin/.
export function isJavaSourceUpload(designtype: number, ext: string): boolean {
  const lower = ext.toLowerCase();
  return JAVA_SOURCE_DESIGN_TYPES.has(designtype) && (lower === ".java" || lower === ".class");
}

// Pages and the Java-source types are addressed by a bare name on the
// server — confirmed by real sample data ({"name": "AccountReset", ...}
// for an Action, no ".java") and by existing Page behaviour. Resources,
// Documentation, and Widgets keep the extension as part of the name (e.g.
// a local "Claude.md" becomes server name "Claude.md", not "Claude").
const BARE_NAME_DESIGN_TYPES = new Set([PAGE_DESIGN_TYPE, 3, 4, 6]); // Pages, Actions, SharedCode, ScheduledActions

// Used when a brand-new local file is created and has to be turned into a
// design element name for the server (the reverse of how a downloaded
// element's bare/extensioned name became a local filename).
export function serverNameFor(baseName: string, ext: string, designtype: number): string {
  return BARE_NAME_DESIGN_TYPES.has(designtype) ? baseName : `${baseName}${ext}`;
}

export const MANIFEST_FILENAME = ".tornado-manifest.json";

export interface ManifestEntry {
  path: string;
  designbucketid: number;
  name: string;
  designtype: number;
  contenttype: string;
  inheritfrom: string | null;
  comment: string;
  options: string;
  designparams: DesignParam[];
}

export interface Manifest {
  appid: number;
  connectionId: string;
  elements: ManifestEntry[];
}

export async function readManifest(appFolder: vscode.Uri): Promise<Manifest | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(appFolder, MANIFEST_FILENAME),
    );
    return JSON.parse(Buffer.from(bytes).toString("utf-8")) as Manifest;
  } catch {
    return undefined;
  }
}

export async function writeManifestFile(appFolder: vscode.Uri, manifest: Manifest): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(appFolder, MANIFEST_FILENAME), bytes);
}

// Lives in Documentation for discoverability, but is dev-tooling config, not
// a real design element — never written to the manifest, and explicitly
// skipped by the watcher (see appWatcher.ts) so it's never uploaded.
const DEV_CONFIG_FOLDER = "Documentation";
const DEV_CONFIG_FILENAME = "devconfig.json";
export const DEV_CONFIG_RELATIVE_PATH = `${DEV_CONFIG_FOLDER}/${DEV_CONFIG_FILENAME}`;

// Mirrored into the app folder root from the shared libraries zip (see
// copyAgentInstructionFiles in javaCompiler.ts) — a one-way copy, not a
// design element: never written to the manifest, and explicitly skipped by
// the watcher (see appWatcher.ts) so local edits are never uploaded and are
// silently overwritten the next time server libraries are refreshed.
// AGENTS.md is the same idea for coding agents other than Claude Code.
export const CLAUDE_MD_FILENAME = "CLAUDE.md";
export const AGENTS_MD_FILENAME = "AGENTS.md";
export const AGENT_INSTRUCTION_FILENAMES = [CLAUDE_MD_FILENAME, AGENTS_MD_FILENAME];

export interface DevConfig {
  javaVersion: string;
}

// Called on every sync (initial and refresh) — only creates the file the
// first time; an existing one is left untouched, since it's where a
// per-app override lives once someone has set it.
export async function ensureDevConfig(appFolder: vscode.Uri, output?: vscode.OutputChannel): Promise<void> {
  const uri = vscode.Uri.joinPath(appFolder, DEV_CONFIG_FOLDER, DEV_CONFIG_FILENAME);
  try {
    await vscode.workspace.fs.stat(uri);
    return;
  } catch {
    // Doesn't exist yet — fall through and create it.
  }
  const javaVersion = vscode.workspace.getConfiguration("tornado").get<string>("javaRelease", "8");
  const config: DevConfig = { javaVersion };
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config, null, 2), "utf-8"));
  output?.appendLine(`  wrote ${DEV_CONFIG_RELATIVE_PATH} (default javaVersion: ${javaVersion})`);
}

export async function readDevConfig(appFolder: vscode.Uri): Promise<DevConfig | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(appFolder, DEV_CONFIG_FOLDER, DEV_CONFIG_FILENAME),
    );
    return JSON.parse(Buffer.from(bytes).toString("utf-8")) as DevConfig;
  } catch {
    return undefined;
  }
}

export interface DesignSyncResult {
  written: number;
}

export async function writeDesignElements(
  appFolder: vscode.Uri,
  appid: number,
  connectionId: string,
  elements: DesignElement[],
  output?: vscode.OutputChannel,
): Promise<DesignSyncResult> {
  const manifestEntries: ManifestEntry[] = [];

  // Always create every design-type folder, even ones with nothing in them
  // yet — so the app's structure (e.g. an empty Documentation/) is visible
  // in the Explorer rather than only appearing once something's added.
  for (const folder of Object.values(DESIGN_TYPE_FOLDERS)) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(appFolder, folder));
  }

  if (elements.length === 0) {
    output?.appendLine(
      "  No design elements returned for this app — nothing to write. " +
        "(Check the request above: is this the right app id, and does the " +
        '"designelements" array actually contain items?)',
    );
  }

  for (const element of elements) {
    assertSafePathSegment(element.name, "design element name");

    const nestedClass = isNestedJavaClassName(element.designtype, element.name);
    const folder = DESIGN_TYPE_FOLDERS[element.designtype] ?? `Type${element.designtype}`;
    const fileName = nestedClass
      ? `${element.name}.class`
      : `${element.name}${extensionFor(element.designtype, element.contenttype)}`;

    if (!(element.designtype in DESIGN_TYPE_FOLDERS)) {
      // Not one of the known types — its folder wasn't pre-created above.
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(appFolder, folder));
    }

    const base64 = nestedClass || !useSourceField(element.designtype, element.contenttype)
      ? element.designdata
      : element.designsource;
    // The unused field (source vs data) comes back as null, not "", for
    // elements that don't populate it.
    const bytes = Buffer.from(base64 ?? "", "base64");
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(appFolder, folder, fileName), bytes);
    output?.appendLine(`  wrote ${folder}/${fileName} (${bytes.length} bytes)`);

    manifestEntries.push({
      path: `${folder}/${fileName}`,
      designbucketid: element.designbucketid,
      name: element.name,
      designtype: element.designtype,
      contenttype: element.contenttype,
      inheritfrom: element.inheritfrom,
      comment: element.comment,
      options: element.options,
      designparams: element.designparams,
    });
  }

  // Persisted so the upload watcher can map a local file back to its
  // designbucketid without another round trip — the window (and any
  // in-memory state) is gone as soon as the workspace folder is opened.
  await writeManifestFile(appFolder, { appid, connectionId, elements: manifestEntries });
  output?.appendLine(`  wrote ${MANIFEST_FILENAME}`);

  await ensureDevConfig(appFolder, output);

  return { written: elements.length };
}
