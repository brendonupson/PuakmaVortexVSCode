import * as vscode from "vscode";
import {
  AppParam,
  Column,
  DataConnection,
  DesignElement,
  DesignParam,
  NewDesignElementPayload,
  Table,
  TornadoClient,
} from "./tornadoClient";
import { assertSafePathSegment } from "./workspaceStorage";
import { logError } from "./logging";

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

export const JAR_CONTENT_TYPE = "application/java-archive";
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

// The local filename for a design element — the exact inverse of
// serverNameFor(), which is what makes a download/upload round trip leave the
// server-side name untouched.
//
// Resources, Documentation and Widgets carry their extension in the
// server-side name already (see BARE_NAME_DESIGN_TYPES), so the name *is* the
// filename. Appending extensionFor() to those unconditionally is what
// produced "CLAUDE.md.md" and "style.css.css". It's equally wrong to append
// one to an extension-less name of those types: a Documentation element named
// "notes" would become "notes.md" locally, and the next upload would push
// that back as a *rename* to "notes.md" server-side.
//
// For the bare-name types the extension is ours to add, but it's still
// skipped when the name already ends in it — a SharedCode "thing.jar" must
// not become "thing.jar.jar".
export function fileNameFor(name: string, designtype: number, contenttype: string): string {
  // A nested/inner class is bytecode only, never a source file — see
  // isNestedJavaClassName.
  if (isNestedJavaClassName(designtype, name)) {
    return `${name}.class`;
  }
  if (!BARE_NAME_DESIGN_TYPES.has(designtype)) {
    return name;
  }
  const ext = extensionFor(designtype, contenttype);
  if (!ext || name.toLowerCase().endsWith(ext.toLowerCase())) {
    return name;
  }
  return `${name}${ext}`;
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
  // SHA-256 hex digest of the compiled .class bytes + source .java bytes
  // (source omitted for nested classes) as of the last successful upload
  // via compileAndUploadFolder(). Absent after any fresh sync/refresh —
  // writeDesignElements() never sets it, so the first compile after a sync
  // re-uploads once per touched element and starts tracking incrementally
  // from there. Purely a local cache of "what did we last send"; never
  // synced by diffManifestParams() and never sent to the server itself.
  uploadedHash?: string;
}

// A column as it sits in the manifest — every field the server's <column>
// shape carries except attributeid/tableid, which are handled separately:
// tableid is implied by nesting (a column always sits inside its table's
// "columns" array) and attributeid is present once the server has assigned
// one, absent on a row added locally that hasn't been created yet. Field
// types match the wire shape exactly (typesize and the "1"/"0" flags stay
// strings) — see the comment on tornadoClient.ts's Column.
export interface ManifestColumn {
  attributeid?: number;
  attributename: string;
  type: string;
  typesize: string;
  allownull: string;
  isprimarykey: string;
  reftable: string;
  extraoptions: string;
  cascadedelete: string;
  autoincrement: string;
  isunique: string;
  ftindex: string;
  description: string;
}

// A table as it sits in the manifest, dbconnectionid dropped for the same
// reason a column's tableid is: implied by nesting. tableid is absent on a
// table added locally that hasn't been created yet.
export interface ManifestTable {
  tableid?: number;
  tablename: string;
  buildorder: number;
  description: string;
  columns: ManifestColumn[];
}

// A data connection as it sits in the manifest. dbconnectionid is always
// present — there is no create-connection endpoint, so a manifest entry
// without one could never be pushed and would just be silently useless.
// schema (the raw auto-generated DDL dump) is deliberately left out: it is
// never accepted by the PUT and is already on disk as DataConnections/
// {connectionname}.sql, so keeping it here too would just be a second,
// driftable copy of the same read-only text.
export interface ManifestDataConnection {
  dbconnectionid: number;
  connectionname: string;
  databasename: string;
  comment: string;
  tables: ManifestTable[];
}

export interface Manifest {
  appid: number;
  connectionId: string;
  // AppParam[] once this app has been synced/refreshed under the manifest
  // parameter-push feature; undefined if it never has been (an older
  // manifest) or the server didn't return a recognisable appparams array.
  // See ApplicationDesign.appparams (tornadoClient.ts) for why this is
  // never defaulted to [] — diffManifestParams() below depends on that.
  appparams: AppParam[] | undefined;
  elements: ManifestEntry[];
  // Same "no trustworthy baseline" semantics as appparams above, and for the
  // same reason: undefined (a manifest from before this feature existed)
  // must never be treated as "empty," or the first edit after upgrading
  // would read as "delete every data connection" — see
  // diffManifestDataConnections() below.
  dataconnections: ManifestDataConnection[] | undefined;
}

// Strips schema and the redundant nesting ids out of a fetched
// DataConnection[] to produce the manifest's editable baseline — the
// inverse of what applyDataConnectionsDiff() sends back piece by piece.
export function toManifestDataConnections(dataconnections: DataConnection[]): ManifestDataConnection[] {
  const toManifestColumn = (column: Column): ManifestColumn => ({
    attributeid: column.attributeid,
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
  });
  const toManifestTable = (table: Table): ManifestTable => ({
    tableid: table.tableid,
    tablename: table.tablename,
    buildorder: table.buildorder,
    description: table.description,
    // Defensive: extractDataConnections()/the wire type assert this shape
    // rather than validate it, so an older server missing "columns" must not
    // take the whole sync down with a TypeError.
    columns: (table.columns ?? []).map(toManifestColumn),
  });
  return dataconnections.map((connection) => ({
    dbconnectionid: connection.dbconnectionid,
    connectionname: connection.connectionname,
    databasename: connection.databasename,
    comment: connection.comment,
    tables: (connection.tables ?? []).map(toManifestTable),
  }));
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

// A real Documentation design element that lives on the server like any
// other, so a team shares one per-app dev configuration rather than each
// checkout inventing its own. Pulled down by the normal sync when the server
// has it; created locally *and pushed* the first time an app doesn't (see
// ensureDevConfig).
const DEV_CONFIG_FOLDER = "Documentation";
const DEV_CONFIG_FILENAME = "devconfig.json";
export const DEV_CONFIG_RELATIVE_PATH = `${DEV_CONFIG_FOLDER}/${DEV_CONFIG_FILENAME}`;
const DEV_CONFIG_DESIGN_TYPE = 5; // Documentation
const DEV_CONFIG_CONTENT_TYPE = "application/json";

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

// Called on every sync (initial and refresh), after the design has been
// written to disk.
//
// When the server has a devconfig.json it arrives as an ordinary
// Documentation element and is already on disk and in the manifest by the
// time this runs — nothing to do, and in particular the server's copy is
// never overwritten with a local default. When it doesn't, a default is
// written locally *and pushed to the server*, so the next person to sync the
// app gets the same configuration instead of silently generating their own.
//
// The push is best-effort: a server that rejects it (no permission, or an
// older build) leaves the local file in place and logs why, because a dev
// config is not worth failing a sync over.
export async function ensureDevConfig(
  appFolder: vscode.Uri,
  appid: number,
  client: TornadoClient,
  manifest: Manifest,
  output?: vscode.OutputChannel,
): Promise<void> {
  const existing = manifest.elements.find((entry) => entry.path === DEV_CONFIG_RELATIVE_PATH);
  if (existing) {
    output?.appendLine(`  ${DEV_CONFIG_RELATIVE_PATH} came from the server (id ${existing.designbucketid})`);
    return;
  }

  const javaVersion = vscode.workspace.getConfiguration("tornado").get<string>("javaRelease", "8");
  const config: DevConfig = { javaVersion };
  const contents = Buffer.from(JSON.stringify(config, null, 2), "utf-8");
  const uri = vscode.Uri.joinPath(appFolder, DEV_CONFIG_FOLDER, DEV_CONFIG_FILENAME);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(appFolder, DEV_CONFIG_FOLDER));
  await vscode.workspace.fs.writeFile(uri, contents);
  output?.appendLine(
    `  ${DEV_CONFIG_RELATIVE_PATH} not on the server — wrote a default (javaVersion: ${javaVersion})`,
  );

  const payload: NewDesignElementPayload = {
    appid,
    name: DEV_CONFIG_FILENAME,
    designtype: DEV_CONFIG_DESIGN_TYPE,
    contenttype: DEV_CONFIG_CONTENT_TYPE,
    // Documentation stores its content in designsource, not designdata.
    designdata: "",
    designsource: contents.toString("base64"),
    inheritfrom: null,
    comment: "Tornado extension dev configuration",
    options: "",
    designparams: [],
  };
  try {
    const created = await client.createDesignElement(appid, payload);
    manifest.elements.push({
      path: DEV_CONFIG_RELATIVE_PATH,
      designbucketid: created.designbucketid,
      name: created.name,
      designtype: created.designtype,
      contenttype: created.contenttype,
      inheritfrom: created.inheritfrom,
      comment: created.comment,
      options: created.options,
      designparams: created.designparams,
    });
    await writeManifestFile(appFolder, manifest);
    output?.appendLine(`  pushed ${DEV_CONFIG_RELATIVE_PATH} to the server (id ${created.designbucketid})`);
  } catch (error) {
    logError(
      output,
      `  could not push ${DEV_CONFIG_RELATIVE_PATH} to the server: ${(error as Error).message} ` +
        "(the local copy is still usable)",
    );
  }
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
  // The manifest as just written — handed back so the caller can finish the
  // sync (pushing a default devconfig.json) without re-reading it from disk.
  manifest: Manifest;
}

export async function writeDesignElements(
  appFolder: vscode.Uri,
  appid: number,
  connectionId: string,
  elements: DesignElement[],
  appparams: AppParam[] | undefined,
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
    const fileName = fileNameFor(element.name, element.designtype, element.contenttype);

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
  // dataconnections isn't known here — the caller (syncDesignToFolder) sets
  // it and rewrites the manifest once writeDataConnections() has also run.
  const manifest: Manifest = { appid, connectionId, appparams, elements: manifestEntries, dataconnections: undefined };
  await writeManifestFile(appFolder, manifest);
  output?.appendLine(`  wrote ${MANIFEST_FILENAME}`);

  // devconfig.json is handled by the caller (ensureDevConfig), which has the
  // client needed to push a default when the server doesn't have one yet.
  return { written: elements.length, manifest };
}

type NamedParam = { paramname: string; paramvalue: string };

// Unordered equality by paramname — a file that was merely reformatted or
// reordered (e.g. by an editor's auto-format) must not look like a parameter
// change. Exported for testability.
export function paramsEqual(a: NamedParam[], b: NamedParam[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const toMap = (params: NamedParam[]) => new Map(params.map((p) => [p.paramname, p.paramvalue]));
  const mapA = toMap(a);
  const mapB = toMap(b);
  if (mapA.size !== mapB.size) {
    return false; // a duplicate paramname on one side collapsed differently
  }
  for (const [name, value] of mapA) {
    if (mapB.get(name) !== value) {
      return false;
    }
  }
  return true;
}

export interface ManifestParamDiff {
  appParams?: AppParam[];
  changedEntries: { entry: ManifestEntry; designparams: DesignParam[] }[];
}

// Compares two snapshots of the same .tornado-manifest.json and reports only
// the designparams/appparams changes worth pushing to the server — the only
// two fields this file lets an external edit (e.g. by an AI coding agent)
// change. Everything else about an entry (name/comment/options/inheritfrom/
// contenttype/designtype/designbucketid) and any added/removed entry is
// intentionally left alone: it rides along verbatim the next time that
// file's content is saved normally, same as any pre-existing manifest field
// always has.
//
// Returns undefined — refuse to push or adopt anything — if `next.appid`
// doesn't match `expectedAppid`, the caller's own fixed identity for this
// app (e.g. AppWatcher's `appid` field). Comparing against `previous.appid`
// instead would trust a manifest that could already have been wrong before
// this edit.
export function diffManifestParams(
  expectedAppid: number,
  previous: Manifest,
  next: Manifest,
  output?: vscode.OutputChannel,
): ManifestParamDiff | undefined {
  if (next.appid !== expectedAppid) {
    logError(
      output,
      `  ${MANIFEST_FILENAME}: "appid" changed to ${next.appid} (expected ${expectedAppid}) — ` +
        "ignoring this edit entirely and not adopting it, to avoid pushing to the wrong application.",
    );
    return undefined;
  }

  const diff: ManifestParamDiff = { changedEntries: [] };

  // See the comment on Manifest.appparams: undefined means "no trustworthy
  // baseline," which must never be treated as "empty" — that would turn the
  // next unrelated appparams edit into a full-replace wipe of every real
  // parameter on the server.
  if (previous.appparams === undefined) {
    if (next.appparams !== undefined) {
      output?.appendLine(
        `  ${MANIFEST_FILENAME}: "appparams" has no baseline (this app hasn't been synced or refreshed ` +
          'since this feature shipped) — not pushing. Run "Tornado: Refresh from Server" once, then edit ' +
          "appparams again.",
      );
    }
  } else if (next.appparams === undefined) {
    output?.appendLine(
      `  ${MANIFEST_FILENAME}: "appparams" key was removed — not pushing (that would delete every ` +
        'application parameter on the server). Restore it or run "Tornado: Refresh from Server" to reset the baseline.',
    );
  } else if (!paramsEqual(previous.appparams, next.appparams)) {
    diff.appParams = next.appparams;
  }

  const prevByPath = new Map(previous.elements.map((e) => [e.path, e]));
  const nextByPath = new Map(next.elements.map((e) => [e.path, e]));

  for (const [path, nextEntry] of nextByPath) {
    const prevEntry = prevByPath.get(path);
    if (!prevEntry) {
      output?.appendLine(`  ${MANIFEST_FILENAME}: "${path}" is new — not created on the server by this feature.`);
      continue;
    }
    if (!paramsEqual(prevEntry.designparams, nextEntry.designparams)) {
      if (supportsDesignParams(nextEntry.designtype)) {
        diff.changedEntries.push({ entry: nextEntry, designparams: nextEntry.designparams });
      } else {
        output?.appendLine(
          `  ${MANIFEST_FILENAME}: "${path}" designparams changed but design type ${nextEntry.designtype} ` +
            "has none — ignored.",
        );
      }
    }
  }
  for (const path of prevByPath.keys()) {
    if (!nextByPath.has(path)) {
      output?.appendLine(`  ${MANIFEST_FILENAME}: "${path}" was removed — not deleted on the server by this feature.`);
    }
  }

  return diff;
}

// Field-by-field string/number equality, deliberately not paramsEqual()'s
// by-name map comparison: typesize and every flag field are significant
// strings ("0" is not the same absence as ""), so normalising anything here
// would make an untouched column look changed and re-PUT it every save.
function columnFieldsEqual(a: ManifestColumn, b: ManifestColumn): boolean {
  return (
    a.attributename === b.attributename &&
    a.type === b.type &&
    a.typesize === b.typesize &&
    a.allownull === b.allownull &&
    a.isprimarykey === b.isprimarykey &&
    a.reftable === b.reftable &&
    a.extraoptions === b.extraoptions &&
    a.cascadedelete === b.cascadedelete &&
    a.autoincrement === b.autoincrement &&
    a.isunique === b.isunique &&
    a.ftindex === b.ftindex &&
    a.description === b.description
  );
}

function tableFieldsEqual(a: ManifestTable, b: ManifestTable): boolean {
  return a.tablename === b.tablename && a.buildorder === b.buildorder && a.description === b.description;
}

function connectionFieldsEqual(a: ManifestDataConnection, b: ManifestDataConnection): boolean {
  return a.connectionname === b.connectionname && a.databasename === b.databasename && a.comment === b.comment;
}

export interface DataConnectionFieldChange {
  dbconnectionid: number;
  connectionname: string;
  databasename: string;
  comment: string;
}

export interface NewManifestTable {
  dbconnectionid: number;
  table: ManifestTable;
}

export interface ManifestTableChange {
  dbconnectionid: number;
  tableid: number;
  fields?: { tablename: string; buildorder: number; description: string };
  newColumns: ManifestColumn[];
  // Always has a real attributeid — only reached once a column has been
  // matched to a baseline entry by id (see diffManifestDataConnections) —
  // typed this way so callers never need an unchecked assertion to address
  // it in a URL.
  changedColumns: (ManifestColumn & { attributeid: number })[];
  removedColumnIds: number[];
}

export interface RemovedManifestTable {
  dbconnectionid: number;
  tableid: number;
  tablename: string;
}

export interface RemovedManifestConnection {
  dbconnectionid: number;
  connectionname: string;
}

export interface ManifestDataConnectionsDiff {
  connectionChanges: DataConnectionFieldChange[];
  newTables: NewManifestTable[];
  tableChanges: ManifestTableChange[];
  // Reported separately from everything above so the caller can confirm
  // before running anything destructive — unlike diffManifestParams(),
  // which never reports a removal at all, this section's whole point is
  // full schema editing, additions and removals both.
  removedTables: RemovedManifestTable[];
  removedConnections: RemovedManifestConnection[];
}

// Compares two snapshots of the manifest's "dataconnections" baseline.
// Unlike diffManifestParams() above (which only ever reports value edits,
// never an add or a remove), this reports every create/update/removal —
// new/renamed/deleted tables and columns are the point of this section, not
// just editing existing values. Nothing here calls the server; the caller
// decides what to do with a removal (see AppWatcher.handleManifestChange).
//
// undefined baseline (either side) mirrors appparams: "no trustworthy
// baseline" must never be treated as "empty," so a manifest predating this
// feature (previous === undefined) never produces a diff, and the key being
// removed entirely (next === undefined) is refused rather than read as
// "delete every data connection."
export function diffManifestDataConnections(
  previous: ManifestDataConnection[] | undefined,
  next: ManifestDataConnection[] | undefined,
  output?: vscode.OutputChannel,
): ManifestDataConnectionsDiff | undefined {
  if (previous === undefined) {
    if (next !== undefined) {
      output?.appendLine(
        `  ${MANIFEST_FILENAME}: "dataconnections" has no baseline (this app hasn't been synced or ` +
          'refreshed since this feature shipped) — not pushing. Run "Tornado: Refresh from Server" once, ' +
          "then edit dataconnections again.",
      );
    }
    return undefined;
  }
  if (next === undefined) {
    output?.appendLine(
      `  ${MANIFEST_FILENAME}: "dataconnections" key was removed — not pushing (that would delete every ` +
        'data connection on the server). Restore it or run "Tornado: Refresh from Server" to reset the baseline.',
    );
    return undefined;
  }

  const diff: ManifestDataConnectionsDiff = {
    connectionChanges: [],
    newTables: [],
    tableChanges: [],
    removedTables: [],
    removedConnections: [],
  };

  const prevByDbId = new Map(previous.map((c) => [c.dbconnectionid, c]));
  const nextByDbId = new Map(next.map((c) => [c.dbconnectionid, c]));

  for (const [dbconnectionid, nextConn] of nextByDbId) {
    const prevConn = prevByDbId.get(dbconnectionid);
    if (!prevConn) {
      output?.appendLine(
        `  ${MANIFEST_FILENAME}: data connection ${dbconnectionid} is new — not created on the server ` +
          "(there is no create-connection endpoint).",
      );
      continue;
    }
    if (!connectionFieldsEqual(prevConn, nextConn)) {
      diff.connectionChanges.push({
        dbconnectionid,
        connectionname: nextConn.connectionname,
        databasename: nextConn.databasename,
        comment: nextConn.comment,
      });
    }

    const prevTablesById = new Map<number, ManifestTable>();
    for (const table of prevConn.tables) {
      if (table.tableid !== undefined) {
        prevTablesById.set(table.tableid, table);
      }
    }
    const nextTablesById = new Set<number>();

    for (const nextTable of nextConn.tables) {
      if (nextTable.tableid === undefined) {
        diff.newTables.push({ dbconnectionid, table: nextTable });
        continue;
      }
      nextTablesById.add(nextTable.tableid);
      const prevTable = prevTablesById.get(nextTable.tableid);
      if (!prevTable) {
        output?.appendLine(
          `  ${MANIFEST_FILENAME}: table ${nextTable.tableid} under data connection ${dbconnectionid} ` +
            "doesn't match anything in the baseline — ignored rather than guessed at. Run " +
            '"Tornado: Refresh from Server" if it should exist, or remove its "tableid" to create it as new.',
        );
        continue;
      }

      const prevColumnsById = new Map<number, ManifestColumn>();
      for (const column of prevTable.columns) {
        if (column.attributeid !== undefined) {
          prevColumnsById.set(column.attributeid, column);
        }
      }
      const nextColumnIds = new Set<number>();
      const newColumns: ManifestColumn[] = [];
      const changedColumns: (ManifestColumn & { attributeid: number })[] = [];
      for (const nextColumn of nextTable.columns) {
        if (nextColumn.attributeid === undefined) {
          newColumns.push(nextColumn);
          continue;
        }
        nextColumnIds.add(nextColumn.attributeid);
        const prevColumn = prevColumnsById.get(nextColumn.attributeid);
        if (!prevColumn) {
          output?.appendLine(
            `  ${MANIFEST_FILENAME}: column ${nextColumn.attributeid} of table ${nextTable.tableid} ` +
              "doesn't match anything in the baseline — ignored rather than guessed at. Run " +
              '"Tornado: Refresh from Server" if it should exist, or remove its "attributeid" to create it as new.',
          );
          continue;
        }
        if (!columnFieldsEqual(prevColumn, nextColumn)) {
          // nextColumn.attributeid is already known non-undefined (checked
          // above) — TS doesn't propagate that through the whole-object push.
          changedColumns.push(nextColumn as ManifestColumn & { attributeid: number });
        }
      }
      const removedColumnIds: number[] = [];
      for (const attributeid of prevColumnsById.keys()) {
        if (!nextColumnIds.has(attributeid)) {
          removedColumnIds.push(attributeid);
        }
      }

      const fieldsChanged = !tableFieldsEqual(prevTable, nextTable);
      if (fieldsChanged || newColumns.length > 0 || changedColumns.length > 0 || removedColumnIds.length > 0) {
        diff.tableChanges.push({
          dbconnectionid,
          tableid: nextTable.tableid,
          fields: fieldsChanged
            ? {
                tablename: nextTable.tablename,
                buildorder: nextTable.buildorder,
                description: nextTable.description,
              }
            : undefined,
          newColumns,
          changedColumns,
          removedColumnIds,
        });
      }
    }

    for (const [tableid, prevTable] of prevTablesById) {
      if (!nextTablesById.has(tableid)) {
        diff.removedTables.push({ dbconnectionid, tableid, tablename: prevTable.tablename });
      }
    }
  }

  for (const [dbconnectionid, prevConn] of prevByDbId) {
    if (!nextByDbId.has(dbconnectionid)) {
      diff.removedConnections.push({ dbconnectionid, connectionname: prevConn.connectionname });
    }
  }

  return diff;
}
