# Tornado Extension

VS Code extension for developing applications on a Tornado application
server: browse the server's inventory and sync an application's design
elements (CSS, JS, HTML, XML, XSL, text, Java) into your workspace.

Started as a skeleton; inventory browsing, download/sync, and upload/watch
are now implemented (with some deliberate gaps noted below). See the
`TODO` markers in `src/` for what's still open.

## Status

- **Diagnostics**: every HTTP request `TornadoClient` makes (method, full
  URL, response status, and — on failure — the response body) is logged to
  the **"Tornado" output channel** (View → Output, select "Tornado" from
  the dropdown), along with sync milestones (files written, byte counts,
  skipped uploads and why). It auto-opens on a sync failure. If a sync
  seems to do nothing, check there first before assuming it's silent — it
  isn't.
- **File editing**: CSS, JS, HTML, XML, XSL, plain text, and Java are all
  covered by VS Code's built-in language support — no custom language
  contribution needed. If Tornado stores design elements under non-standard
  file extensions, add a `contributes.languages` *file-association* entry
  in `package.json` mapping the extension to an existing language id (e.g.
  `*.tornxsl` → `xml`) rather than defining a new grammar.
- **Connection configuration**: multiple named connections (e.g. Staging,
  Production) can be configured, each with its own server URL, username, and
  password. `Tornado: Add Connection` prompts for all four and makes the new
  connection active; `Tornado: Select Connection` switches the active one
  (persists across windows/folders); `Tornado: Edit Connection` updates an
  existing one's name/URL/username (password field is left blank to keep
  the current password); `Tornado: Delete Connection` removes one (settings
  entry + stored credentials). All four are reachable via the Command
  Palette *and* via icons on the Inventory view's title bar (refresh/select/
  add always visible; edit/delete under the "..." overflow menu) — not just
  from the initial empty-state welcome screen, which disappears once a
  connection is active. Connection name/URL pairs are stored
  in **User** settings (`tornado.connections`, global scope — available in
  every workspace, not just the one they were added from); usernames/
  passwords are stored in VS Code's `SecretStorage` (OS keychain-backed),
  keyed by each connection's generated id — never in plain text or in
  settings.json.
- **Inventory**: the Tornado activity bar icon shows an "Inventory" tree
  view for the *active* connection (shown in the view's description).
  `TornadoClient.fetchInventory()` does `GET {serverUrl}/vortex` with HTTP
  Basic Auth and lists the returned apps (fields: `appname`, `appid`,
  `appdisplayname?`, `appgroup`, `description`, `templatename`,
  `appversion?`, `inheritfrom`), grouped into a collapsible node per
  `appgroup` (apps with no group land under "(ungrouped)"), groups sorted
  alphabetically, and apps within each group sorted by `appname`. Apps whose
  `templatename` is set show a template icon; each app's `appversion` (when
  present) shows as its description text; apps whose `inheritfrom` is set
  are shown in red, via a `FileDecorationProvider` keyed off a synthetic
  `resourceUri` on each item (VS Code tree items have no direct label-color
  property). The
  empty-state message distinguishes three cases: no connections configured
  yet, connections exist but none is
  active, and (via `treeView.message`, plus a line in the "Tornado" output
  channel) an active connection whose inventory fetch actually failed —
  distinct from an empty tree meaning "not configured."
- **Design element folder**: clicking an app in the Inventory tree creates
  `.tornado/<connectionName>_<appgroup>_<appname>/` in the open workspace
  (appgroup is optional and dropped when empty), fetches its full design via
  `GET /vortex/{appid}/` with HTTP Basic Auth, and writes each element from
  the response's `designelements` array to disk (`designSync.ts`). If no
  folder is open, the error offers an "Open Folder..." button
  (`vscode.openFolder`) instead of a dead end — note that opening a folder
  reloads the window, so the sync has to be retried afterward rather than
  resuming automatically. Running `Tornado: Sync Application to Workspace`
  from the Command Palette instead only prompts for an app name — since it
  doesn't know the app's id, it can create the local folder but can't
  download (a warning explains this).

  All seven design-type subfolders (Pages, Resources, Actions, SharedCode,
  Documentation, ScheduledActions, Widgets) are always created, even ones
  with nothing in them, so an app's structure is visible in the Explorer
  right away rather than folders only appearing once something's added to
  them. Each element is written under the subfolder named for its
  `designtype` (1=Pages, 2=Resources, 3=Actions, 4=SharedCode,
  5=Documentation, 6=ScheduledActions, 7=Widgets). Actions/SharedCode/ScheduledActions decode
  `designsource` (base64) to a `.java` file; Documentation also uses
  `designsource`, with its extension guessed from `contenttype`. Everything
  else (Pages, Resources, Widgets, and any jar found in SharedCode via
  `contenttype == "application/java-archive"`) decodes `designdata` instead
  — Pages get a `.phtml` extension rather than `.html`, since Tornado pages
  mix in non-standard tags that would mislead HTML tooling; other types get
  an extension guessed from `contenttype`. A `.tornado-manifest.json` is
  written alongside each app's files (`designSync.ts`) recording each
  element's `designbucketid`/name/type/contenttype/etc. plus which
  connection it came from — the extension host restarts when a folder is
  opened, so this is what `tornado.startWatching` uses to map a local file
  back to its server-side element without another round trip.

  This logic was informed by `vortex-cli-mirror`, an existing Python CLI for
  the same server (SOAP-based, not REST, so only its file-handling
  conventions transferred, not its API calls) — worth checking if you
  extend this further, e.g. for Java package-based subfolder nesting or a
  compile pipeline, neither of which is implemented here.

- **Uploading local changes** (`appWatcher.ts`): after a sync, the success
  message offers a "Start Watching" button (or run `Tornado: Start
  Watching Application` / `Tornado: Stop Watching Application` from the
  Command Palette, which lists synced apps found via
  `.tornado/*/.tornado-manifest.json`). While watching, a
  `vscode.FileSystemWatcher` on that app's folder does:
  - **Change** → `PUT /vortex/{appid}/design/{designbucketid}`, same JSON
    shape as a downloaded element, with the edited field (`designsource` or
    `designdata`, per the same type rule as download) refreshed.
  - **Create** → `POST /vortex/{appid}/design`. The new element's
    `designtype` comes from the file's parent folder name and `contenttype`
    is inferred *backwards* from its extension (the reverse of the
    download-side mapping) — the server is assumed to respond with the
    full created element (to learn its new `designbucketid`); this is
    **unverified against a real request** and fails loudly rather than
    silently corrupting the manifest if the response shape doesn't match.
    The server-side `name` sent depends on design type: Pages and the
    Java-source types are addressed by a bare name (a local `Home.phtml`
    becomes server name `Home`, confirmed by real sample data — Actions
    have no `.java` in their `name` either), while Resources, Documentation,
    and Widgets keep the extension as part of the name (a local
    `Documentation/Claude.md` becomes server name `Claude.md`, contenttype
    `text/markdown`) — see `serverNameFor()` in `designSync.ts`.
  - **Delete** → confirmation prompt (modal, since deleting from a live
    server can't be undone), then `DELETE /vortex/{appid}/design/{designbucketid}`.
    The local file is already gone by the time the event fires — declining
    the prompt just leaves the server-side element in place, it doesn't
    restore the local file.

  One thing deliberately **not** handled:
  - **Java source/class changes are skipped by the watcher entirely**
    (Create and Update, for both `.java` and `.class` files under
    Actions/SharedCode/ScheduledActions) — `designdata` for these types is
    *compiled bytecode*, not the source text, so PUTting `designsource`
    alone would silently fail to take effect. These are handled instead by
    the dedicated compile pipeline below, not the per-file watcher; changes
    are logged to the "Tornado" output channel and otherwise ignored here.
    (`.jar` files under SharedCode are unaffected — they upload normally via
    `designdata`.)
  - **Re-syncing an already-watched app** is wrapped in
    `AppWatcher.runSuppressed()`, which pauses event handling (with a
    short drain delay, since filesystem events can lag slightly behind the
    write that caused them) so the fresh download doesn't get echoed back
    to the server as a wave of redundant uploads.

- **Refreshing from the server**: `Tornado: Refresh from Server` re-runs a
  sync (fetch + overwrite local files, using the same
  `syncDesignToFolder()`/suppression logic as the initial sync and as
  re-syncing a watched app) for an app already synced into the workspace,
  after a confirmation prompt since it overwrites local files. It's also
  available as a `$(cloud-download)` button in the **file Explorer's**
  title bar (not the Tornado Inventory view), next to VS Code's native
  refresh button — VS Code doesn't allow extensions to hook into or wrap
  built-in commands like "Refresh Explorer" directly, so this is a
  companion button rather than the native one gaining new behavior.

- **Editing design element properties**: `Tornado: Edit Design Element
  Properties`, from the Command Palette (using the active editor's file) or
  by right-clicking a design element file in the Explorer, opens a picker
  for the element's `name`/`comment`/`options`/`inheritfrom` — content
  (`designdata`/`designsource`) and `designparams` aren't touched, and are
  re-sent exactly as fetched fresh from the server rather than reconstructed
  from the local file, so a Java element's compiled bytecode (`designdata`)
  is never overwritten with its source text by accident. Renaming:
  - Updates the server via the same `PUT` used elsewhere, then renames the
    local file to match (via a `WorkspaceEdit`, so any editor with it open
    follows) and updates the manifest — suppressing the app's watcher around
    the rename first, if it's running, so the delete+create filesystem
    events a rename produces aren't mistaken for a real deletion.
  - Is refused for a nested/inner/anonymous class (`Foo$Bar`) — its name is
    fixed by its enclosing top-level class, and `Tornado: Compile & Upload
    Java` would just recreate it under the original name on the next
    compile, orphaning the renamed copy on the server.
  - For a top-level Actions/SharedCode/ScheduledActions class, succeeds but
    warns that the `public class` declaration inside the file still needs
    updating to match — the compiler (not the server) ties a Java design
    element to its class name, and a mismatched declaration fails to
    compile.

- **Creating an application**: `Tornado: Create Application` (Command
  Palette, or the $(new-file) button in the Inventory view's title bar once
  a connection is active) prompts for the same property set as editing one
  below (`appname`/`appgroup`/`description`/`templatename`/`inheritfrom`)
  via the same picker, then `POST`s it to the active connection. **`POST
  /vortex` is not a confirmed endpoint either** — extrapolated the same way
  `updateApplication()` extrapolates its `PUT`, by mirroring
  `createDesignElement()`'s POST-and-read-back-the-new-id pattern onto the
  application level; see `TornadoClient.createApplication()`. Once created,
  behaves like picking a freshly-appeared app from the Inventory tree: a
  local folder is created and its (likely empty) design is synced into it,
  with an offer to start watching it — but since the application already
  exists on the server by that point, a failure in this local-sync half is
  reported as a warning telling you to sync it manually via the Inventory
  tree, not as a creation failure, so nothing about a network hiccup here
  would suggest re-running the command (which would create a duplicate
  application server-side).

- **Editing application properties**: `Tornado: Edit Application
  Properties`, from the Command Palette (offers a picker of synced apps) or
  by right-clicking a synced app's folder in the Explorer, edits the
  application itself rather than one of its design elements —
  `appname`/`appgroup`/`description`/`templatename`/`inheritfrom`.
  `appdisplayname` and `appversion` are read (used in the picker's title and
  left untouched in the update payload) but not editable here. **`PUT
  /vortex/{appid}` is not a confirmed
  endpoint** — nothing in this codebase corroborates it, unlike the
  design-element endpoints; it's extrapolated by symmetry with the existing
  `GET /vortex/{appid}/` (see `TornadoClient.updateApplication()`) and needs
  verifying against a real server. Renaming `appname`/`appgroup` — which
  double as the local folder-name segments, see `folderName()` in
  `workspaceStorage.ts` — renames the local `.tornado/<folder>` to match
  (again via a `WorkspaceEdit`), tearing down and restarting the app's
  watcher around the move if one was running, since a live
  `vscode.FileSystemWatcher` can't just follow its root folder being
  renamed out from under it the way a suppressed one can follow a single
  file rename.

- **Compiling and uploading Java** (`javaCompiler.ts`): `Tornado: Compile &
  Upload Java` batch-compiles all `.java` files under a synced app's
  Actions, SharedCode, and ScheduledActions folders together in one
  invocation (they can reference each other, so per-file compilation on
  save isn't viable — this is why it's a separate explicit command, not
  wired into the file watcher). Compiled classes land in a `zbin/` folder
  at the app root rather than next to their `.java` — a single `-d` flag
  needs one shared output root regardless of which of the three folders a
  source came from. `zbin` isn't a recognised design-type folder, so the
  watcher (if running) silently ignores anything written there.

  **Compiles with `ecj` (the Eclipse Compiler for Java), not `javac`** —
  deliberately recreating Eclipse's own compilation model rather than
  javac's, since that's what was asked for. `ecj` is literally the compiler
  Eclipse's IDE runs internally, invoked here as `java -jar ecj-<version>.jar
  -d zbin -cp <classpath> --release <N> -proceedOnError <sources>`.
  `-proceedOnError` is the reason for choosing it: verified empirically that
  it keeps generating `.class` output for every source it can — including a
  stub for a class with a genuinely unresolved import — embedding an error
  that only throws *at runtime, if that specific broken part is actually
  reached*, instead of `javac`'s behaviour where a single unresolved import
  can discard output for the *entire* batch. That's what makes "every save
  still reaches the server, even if something elsewhere doesn't compile"
  possible without an exclude-and-retry workaround. Pinned to a known-good
  version (`org.eclipse.jdt:ecj:3.46.0`, EPL-licensed) rather than
  "latest", downloaded once from Maven Central into the extension's
  cross-workspace global storage (`context.globalStorageUri`, via
  `ensureEcj()`) — it's a dev tool, not tied to any one server connection
  or workspace, unlike the server jars above.

  The compile classpath comes from the server itself, not a jar bundled
  with the extension: `GET /vortex/systemjar` downloads the server's own
  `puakma.jar`, and `GET /vortex/libraries` downloads a zip of its other
  shared library jars (unpacked locally with `unzip`, since a zip-of-jars
  isn't itself a valid classpath entry the way a single jar/zip of classes
  would be). This guarantees client and server are compiling against the
  same code, and sidesteps having to bundle or license a third-party
  server-framework jar. Both are cached per-connection under
  `.tornado/.lib/<connectionId>/` (shared across every app synced from that
  connection) and only re-downloaded if missing — this happens
  automatically on every sync/refresh (`syncDesignToFolder()` in
  `extension.ts`, non-fatal if it fails, so a server without these
  endpoints doesn't break a normal file sync), not only lazily on first
  compile, so the classpath is warm as soon as an app is connected. Run
  `Tornado: Refresh Server Libraries` after a server-side upgrade to force
  a fresh copy.
  `tornado.compileClasspath` (a settings array, empty by default) can add
  extra jar/directory paths on top of the server-provided ones if needed.

  The `java` launcher used to run `ecj` is located via `tornado.javaHome`
  (a setting, empty by default), then `$JAVA_HOME`, then `java` on `PATH`.
  Compiled bytecode's target version (`--release`) comes from
  **`Documentation/devconfig.json`**
  (`{ "javaVersion": "..." }`) — created automatically on every sync (initial
  and refresh) if it doesn't already exist yet, seeded with the current
  `tornado.javaRelease` setting's value (default `"8"`, a conservative
  floor), and left untouched on every subsequent sync once it exists — so
  it's a per-app override that survives re-syncing. `tornado.javaRelease`
  itself is only the fallback when `devconfig.json` is missing or doesn't
  set `javaVersion`. This exists because the server doesn't expose the Java
  version it expects via REST the way `vortex-cli-mirror` reads it over
  SOAP; adjust the per-app file if compilation rejects the release, or if
  uploaded classes fail to load on the server. Despite living inside
  `Documentation/`, `devconfig.json` is dev tooling config, not a design
  element — it's never added to the manifest and the watcher explicitly
  ignores it, so it's never uploaded.

  After compiling, each resulting top-level class is matched back to its
  manifest entry by class name and uploaded via the same
  `PUT /vortex/{appid}/design/{designbucketid}` used elsewhere, with both
  `designdata` (the compiled bytecode) and `designsource` (the current
  `.java` text) refreshed in the same request, so both server-side fields
  stay in sync rather than just the bytecode.

  Nested/inner/anonymous classes (any `.class` file with `$` in its name,
  e.g. `Outer$Inner.class`) have no `.java` of their own to match a manifest
  entry by name, so they're deployed separately as SharedCode design
  elements (designtype 4): updated in place if a same-named SharedCode
  element already exists, or created via `POST /vortex/{appid}/design` the
  first time one is seen, with the new `designbucketid` recorded in the
  manifest. Only `designdata` (the bytecode) is sent — there's no source to
  put in `designsource`. On sync, these come back down as a plain `.class`
  file (never a `.java`), so they're never mistaken for a real source file
  and fed back into `ecj`.

  **A broken file doesn't hold back the rest of the app**: because of
  `-proceedOnError` above, `CompileResult.failedSourceNames` (sources that
  produced *no* class output at all, not even a stub) is normally empty
  even when other sources have real errors — `hadErrors` can be `true`
  while everything still uploaded. The command and auto-compile-on-save
  only surface a *warning* toast when `failedSourceNames` is actually
  non-empty (a source produced nothing to upload); a `hadErrors`-but-fully-
  uploaded run is logged to the output channel only, since under this
  model that's routine, not exceptional — the whole point is that transient
  errors elsewhere shouldn't interrupt saving.

  **Auto-compile on save**: while an app is being watched, saving any
  `.java` file under Actions/SharedCode/ScheduledActions triggers this same
  compile-and-upload automatically (`tornado.compileOnSave`, on by
  default) — but it always recompiles the *whole app's* Java, not just the
  saved file, since these can reference each other and a single-file
  compile could miss that. Debounced per app folder (400ms) so saving
  several files at once (e.g. Save All) triggers one compile, and a second
  save while a compile is still running is skipped rather than overlapped.
  Not tied to `tornado.compileAndUpload`'s manual invocation in any other
  way — both just call the same underlying `compileAndUploadFolder()`.

- **Java editor IntelliSense** (`javaIntellisense.ts`): separate from the
  javac compile classpath above — Actions/SharedCode/ScheduledActions are
  loose files with no Maven/Gradle/Eclipse project behind them, so without
  this, VS Code's Java language server (the `redhat.java` extension) has no
  classpath for them and shows framework types like `ActionRunner` as
  "cannot be resolved to a type" even though compilation works fine. Every
  sync/refresh that downloads server jars also adds
  `.tornado/.lib/**/*.jar` to the workspace's `java.project.referencedLibraries`
  setting (merged in, not overwritten, and only once — existing entries are
  left alone). Requires the `redhat.java` extension to be installed; if it
  isn't, this is skipped with a note in the "Tornado" output channel rather
  than failing. The Java language server can need a reload or "Java: Clean
  the Java Language Server Workspace" to pick up a newly-added classpath
  entry — the extension prompts for that the first time it adds one.

Open decision: whether `.tornado/` should be git-ignored (a local sync
cache) or committed (the source of truth) — not yet resolved.

## Development

Requires Node.js ≥ 18 (a `.nvmrc` pinning 20 is included — run `nvm use`).

```sh
npm install
npm run watch   # or press F5 in VS Code to launch the Extension Development Host
```

- `npm run lint` — ESLint
- `npm test` — compiles and runs the extension test suite
- `npm run package` — production bundle; `npx @vscode/vsce package` to build a `.vsix`
