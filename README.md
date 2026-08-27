# Tornado Extension

VS Code extension for developing applications on a Tornado application
server: browse the server's inventory and sync an application's design
elements (CSS, JS, HTML, XML, XSL, text, Java) into your workspace.

Started as a skeleton; inventory browsing, download/sync, and upload/watch
are now implemented (with some deliberate gaps noted below). See the
`TODO` markers in `src/` for what's still open.

## Status

- **Diagnostics**: every HTTP request `TornadoClient` makes (method, full
  URL, request body size — and the body itself when under 2KB — response
  status, and on failure the response body) is logged to the **"Tornado"
  output channel** (View → Output, select "Tornado" from the dropdown), along
  with sync milestones (files written, byte counts, skipped uploads and why)
  and a trace of every command: what ran, what it was aimed at, whether it
  finished, and how long it took. It auto-opens on a sync failure. If a sync
  seems to do nothing, check there first before assuming it's silent — it
  isn't.

  **Failures appear in red.** The channel is a `LogOutputChannel`
  (`logging.ts`), so ordinary progress is logged at info level and anything
  that failed goes through `error()`, which the Output panel renders in red:
  failed uploads and downloads (any non-2xx or network error), ecj's compile
  diagnostics, unexpected response shapes, watcher errors, and any command
  that throws. `logError()` is the one entry point for that, and falls back to
  a plain line if handed a channel that isn't one of ours.

  **The same stream is mirrored to `console.log`/`console.error`**, timestamped
  and prefixed with `[Tornado]` — which is where the **Debug Console** shows it
  when the extension is run with F5, and Help → Toggle Developer Tools shows it
  in a normal install. So a debugging session sees extension activity
  interleaved with its own breakpoints and stack traces without switching to
  the Output panel. Only what's already written to the channel is mirrored:
  design element *contents* (base64) are never logged, just names and byte
  counts.
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
  `tornado/<connectionName>_<appgroup>_<appname>/` in the open workspace
  (appgroup is optional and dropped when empty), fetches its full design via
  `GET /vortex/{appid}/` with HTTP Basic Auth, and writes each element from
  the response's `designelements` array to disk (`designSync.ts`).

  **Opening an app that's already synced replaces the local copy rather than
  writing over the top of it**, so what lands on disk matches the server
  exactly — otherwise an element deleted on the server lingers locally
  forever, and the watcher could upload a stale file back. Because that
  discards local work, a modal confirmation comes first
  (`confirmAndResetAppFolder()` in `extension.ts`), offering **Delete & Sync
  Fresh**, **Sync Without Deleting** (the older write-over-the-top behaviour,
  for when there's local work to keep) and Cancel. It only appears when the
  folder actually has something in it — a first sync, or a re-sync into an
  empty folder, goes straight through.

  Three things that matter on the delete path: the app's **watcher is
  disposed before anything is removed** (its delete handler treats a vanished
  file as "the user deleted this design element" and asks whether to delete it
  server-side too, which is the last thing a refresh should trigger) and
  restarted afterwards if it was running; the folder goes to the **OS trash**
  where the filesystem supports it, falling back to a permanent delete; and
  **`Documentation/devconfig.json` is carried across**, since the per-app
  `javaVersion` override is local dev-tooling config rather than server design
  and is meant to survive re-syncing. `zbin/` compiled output is not
  preserved — the next compile rebuilds it. `Tornado: Refresh from Server` is
  unchanged and still writes over the top without deleting. If no
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
  an extension guessed from `contenttype`.

  **An extension is only ever *added* to the design types whose server-side
  name is bare** (Pages, Actions, SharedCode, ScheduledActions). Resources,
  Documentation and Widgets already carry theirs in the name, so the name *is*
  the filename — otherwise `Documentation/CLAUDE.md` lands as `CLAUDE.md.md`.
  `fileNameFor()` in `designSync.ts` is the single place that decides this,
  used by both the download and the rename path, and is the exact inverse of
  `serverNameFor()` — which is what stops a round trip from quietly renaming
  an element (adding `.md` to a Documentation element named `notes` would
  push it back as a rename to `notes.md`). A `.tornado-manifest.json` is
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
  `tornado/*/.tornado-manifest.json`). While watching, a
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

- **Progress feedback**: syncing an app (clicking it in the Inventory tree
  or running `Tornado: Sync Application to Workspace`), the sync half of
  `Tornado: Create Application`, and `Tornado: Refresh from Server` each
  wrap their download in a `vscode.window.withProgress` notification-style
  toast so background work is visible rather than silent — sync/create
  titles it with the app's `/appgroup/appname` (`appPathLabel()` in
  `extension.ts`, group segment dropped when ungrouped) so a same-named app
  in a different group isn't ambiguous. Notification-location progress
  stacks per call, so clicking several apps in quick succession shows one
  toast per app rather than one being silently overwritten by the next.

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

- **Closing an application**: `Tornado: Close Application`, from
  right-clicking a synced app's folder in the Explorer (or the Command
  Palette, which then prompts you to pick one), deletes that app's local
  folder after a confirmation prompt — nothing is pushed to or deleted from
  the server, it's purely local. Stops the app's watcher first if it's
  running, and cleans up the `java.project.sourcePaths`/
  `java.project.referencedLibraries` workspace-setting entries
  `ensureJavaIntelliSense` added for it (the shared `tornado/.lib/**/*.jar`
  glob itself is left in place, since other synced apps still need it), so
  nothing about the closed app lingers. The folder goes to the OS trash
  where available. Also checks whether any other synced app under
  `tornado/` still uses that app's connection; if none do,
  `tornado/.lib/<connectionId>/` (the downloaded `puakma.jar`/shared
  libraries for that connection, see "Compiling Java" below) is deleted too
  rather than left behind as orphaned disk usage — a future sync/refresh on
  that connection just re-downloads it from scratch.

- **Editing design element properties**: `Tornado: Edit Design Element
  Properties`, from the Command Palette (using the active editor's file) or
  by right-clicking a design element file in the Explorer, opens a picker
  for the element's `name`/`comment`/`options`/`inheritfrom` — content
  (`designdata`/`designsource`) and `designparams` aren't touched, and are
  re-sent exactly as fetched fresh from the server rather than reconstructed
  from the local file, so a Java element's compiled bytecode (`designdata`)
  is never overwritten with its source text by accident.

  The Explorer entry is offered only on a file that is actually inside a
  design-type folder (`tornado/<app>/<TypeFolder>/<file>`, including a
  `Type<N>/` folder for a design type this extension doesn't know by name).
  It stays off `CLAUDE.md`/`AGENTS.md`, `.tornado-manifest.json`,
  `Documentation/devconfig.json`, compiled `zbin/` output and the cached
  `.lib/` jars — none of which is a tracked design element, so offering the
  command there could only ever end in an error.

  Renaming:
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

- **Editing design element parameters** (`designparams`): `Tornado: Edit
  Design Element Parameters`, from the Command Palette (using the active
  editor's file) or by right-clicking a design element file in the Explorer.
  **Only Pages, Resources and Actions have editable parameters** — SharedCode,
  Documentation, ScheduledActions and Widgets have none, so the context-menu
  entry is hidden for them (its `when` clause matches only the `Pages`,
  `Resources` and `Actions` folders, which also keeps it off `devconfig.json`,
  `CLAUDE.md`/`AGENTS.md` and `zbin/`; note that `ScheduledActions/` does
  *not* match the `Actions` alternative, since the clause anchors each folder
  name between slashes). The command re-checks the design type itself, since
  the Command Palette route runs against whatever file is in the active
  editor without consulting any `when` clause. `supportsDesignParams()` in
  `designSync.ts` is the source of truth for the type numbers; the folder
  names in `package.json` have to be kept in step with it.

  For the types that do have them, **which parameters exist depends on the
  design type**, mirroring the
  server's own `saveParams()`: every type carries `AnonymousAccess`,
  `MinifyLevel` and `CompositeElement` (each set to `1` or not set at all),
  and a **Page** additionally carries `OpenAction` and `SaveAction` (picked
  from the app's Actions) and `ParentPage` (picked from its Pages). Any other
  parameter the element already has is listed after those as free text and
  re-sent as-is — the client never drops one it doesn't recognise, though
  whether the server persists a name outside its own `saveParams()` list is
  up to the server. The `1`-or-absent rule is the same as for application
  parameters above: a parameter set to nothing is omitted rather than written
  as an empty string, while one the server already has blank and nobody
  touched is re-sent untouched.

  Reading and writing go through `GET`/`PUT
  /vortex/{appid}/design/{designbucketid}/params` — the design-element-level
  counterpart of `/vortex/{appid}/appparams` — with the `PUT` body wrapped as
  `{"designparams": [...]}` (that key rather than the URL's `params`, to match
  the field name design elements already use in their own JSON). The
  element's content is never fetched or re-sent, so a parameter change can't
  disturb `designdata`/`designsource`. **The manifest's copy of
  `designparams` is updated too, and that matters**: the watcher re-sends the
  manifest's parameters with every file upload, so a stale copy there would
  silently revert a parameter change the next time the file was saved.

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

- **The three application-level commands** — `Edit Application Properties`,
  `Edit Application Parameters` and `Edit Keywords` — appear in the Explorer
  context menu **only on an application's own root folder**
  (`tornado/<app>`), never on the design-type subfolders inside it, on
  `zbin/`, on the shared `.lib/` cache, or on `tornado/` itself. Those have no
  manifest to act on, so the commands could only fail there. The Command
  Palette route is unaffected: it offers a picker of synced applications
  (`pickSyncedAppFolder()`).

- **Editing application properties**: `Tornado: Edit Application
  Properties`, from the Command Palette (offers a picker of synced apps) or
  by right-clicking a synced app's root folder in the Explorer, edits the
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
  `workspaceStorage.ts` — renames the local `tornado/<folder>` to match
  (again via a `WorkspaceEdit`), tearing down and restarting the app's
  watcher around the move if one was running, since a live
  `vscode.FileSystemWatcher` can't just follow its root folder being
  renamed out from under it the way a suppressed one can follow a single
  file rename.

- **Editing application parameters** (`APPPARAM`): `Tornado: Edit Application
  Parameters`, from the Command Palette or by right-clicking a synced app's
  folder in the Explorer, edits the application's key/value parameters. The
  dialog is the same QuickPick loop the two property editors use, listing ten
  well-known parameter names with their current values: `OpenAction`,
  `OpenAction1`, `SaveAction`, `SaveAction1` (picked from the app's Actions),
  `LoginPage` (picked from its Pages), `DefaultOpen` (free text),
  `DisableApp`, `DisableScheduledActions`, `ForceSecureConn` (set to `1` or
  not set at all), and `DefaultLocale` (picked from a locale list showing
  e.g. "English (Australia)" while storing `en-AU`). Action/Page choices come
  from the local manifest — i.e. the last sync — so every choice list also
  offers manual entry for a value that exists server-side but isn't synced
  locally. Locale labels are generated with `Intl.DisplayNames`
  (`languageDisplay: "standard"`, with a hand-composed fallback for older ICU
  builds that ignore the option, which would otherwise render "Australian
  English"). Parameters the application already has beyond those ten are
  listed after them as free text and re-sent as-is — the client never drops
  one it doesn't recognise, though whether the server persists a name outside
  its own list is up to the server.

  **A parameter set to nothing is omitted from the save, not written as an
  empty string** — that's how "`1` or not set" is expressed. To avoid that
  rule deleting rows nobody touched, a parameter the server already has with
  a blank value is re-sent unchanged unless it was actually edited.

  Reading and writing go through `GET`/`PUT /vortex/{appid}/appparams`, a
  collection of its own alongside `/vortex/{appid}/design` — so editing a
  parameter touches neither the application's own properties nor its design
  elements. The `PUT` body is `{"appparams": [...]}` — the full set, which
  replaces the old one, so a parameter the editor drops is expressed by its
  absence (a partial write couldn't remove anything). It's wrapped in an
  object rather than sent as a bare top-level array because the server reads
  no data from a bare array, and because every other write in this API is an
  object anyway. The read is deliberately tolerant (`extractAppParams()` in
  `tornadoClient.ts`): it takes that wrapped form, an object wrapping the
  array under any other key, or a bare array.

- **Editing parameters by hand** (e.g. from an AI coding agent like Claude
  Code): while an app is being watched, a direct edit to
  `.tornado-manifest.json` on disk — not through either editor above — is
  also picked up and pushed to the server, via `AppWatcher.handleManifestChange()`
  in `appWatcher.ts`. This is the process for a tool that edits files
  directly rather than driving the extension's own UI.

  - **Only two fields are synced this way**: an entry's `designparams`
    (matched to its design element by `path`) and the top-level `appparams`.
    Any other edit — renaming an entry's `name`/`comment`/`options`, adding
    or removing an entry, changing `appid`/`connectionId` — is logged to the
    output channel and otherwise ignored; it isn't pushed, and isn't
    reverted either, so it rides along unchanged the next time that entry's
    content file is next saved normally (true of any manifest field, not
    new here).
  - **Full-replace semantics apply here too**: a param omitted from the
    edited array is deleted server-side, the same as dropping one in the
    interactive editors above.
  - **`appparams` needs a baseline first.** A manifest written before an app
    has been synced or refreshed at least once under this feature has no
    `appparams` to compare against, so an edit to it is skipped (and logged)
    rather than risking a partial write that looks like "delete everything
    except what I just typed." Run `Tornado: Refresh from Server` once if an
    `appparams` edit doesn't seem to be taking effect. `designparams` has no
    such caveat — it's always populated by the ordinary design pull.
  - Comparison is by parameter name, not array position, so reformatting or
    reordering the JSON (e.g. an editor auto-formatting on save) never looks
    like a change.
  - Like every other local-edit-to-upload path in this extension, this only
    works while the app's watcher is running (`Tornado: Start Watching`) —
    an edit made while nothing is watching that folder sits locally until
    the next manual sync.
  - Set `tornado.pushLocalParameterEdits` to `false` to hand-edit the
    manifest offline without triggering a live push.

- **Editing data connections, tables, and columns** (`DBCONNECTION`/
  `PMATABLE`/`ATTRIBUTE`): unlike everything above, this is hand-editing
  only — there's no interactive editor for it. Every data connection the app
  pull returns (`design.dataconnections`), with its tables and their columns
  embedded, is written into `.tornado-manifest.json`'s `"dataconnections"`
  section on every sync/refresh, and a direct edit to it — while the app's
  watcher is running — is picked up and pushed the same way `appparams`/
  `designparams` edits are, via the same `handleManifestChange()`.

  ```
  GET    /vortex/{appid}/database              -> {"dataconnections": [...]}
  GET    /vortex/{appid}/database/{dbid}       -> the bare data connection, tables embedded
  PUT    /vortex/{appid}/database/{dbid}       body {"database": {connectionname, databasename, comment}}
  DELETE /vortex/{appid}/database/{dbid}       -> cascades: every column, then every table, then the connection

  GET    /vortex/{appid}/database/{dbid}/table/{id}     -> the bare table, columns embedded
  POST   /vortex/{appid}/database/{dbid}/table          body {"table": {tablename, buildorder, description}}
  PUT    /vortex/{appid}/database/{dbid}/table/{id}     body {"table": {...}}
  DELETE /vortex/{appid}/database/{dbid}/table/{id}     -> cascades: every column, then the table

  POST   /vortex/{appid}/database/{dbid}/table/{id}/column/          body {"column": {...}}
  PUT    /vortex/{appid}/database/{dbid}/table/{id}/column/{id}      body {"column": {...}}
  DELETE /vortex/{appid}/database/{dbid}/table/{id}/column/{id}
  ```

  Every response above that carries a single object (`GET`-by-id, `POST`,
  `PUT`) is bare — the same convention `GET`/`POST`/`PUT /vortex/{appid}/keywords`
  settled on. Request bodies stay wrapped (`{"database": {...}}`,
  `{"table": {...}}`, `{"column": {...}}`) regardless. Only `connectionname`/
  `databasename`/`comment` are settable on a connection — `dburl`, `dbdriver`,
  `dbusername`, `dbpassword`, `dburloptions`, `options`, and `inheritfrom` are
  never exposed by `GET` and can't be set through this API. A column's flag
  fields (`allownull`, `isprimarykey`, `cascadedelete`, `autoincrement`,
  `isunique`, `ftindex`) are always the strings `"1"`/`"0"`, never JSON
  booleans, and `typesize` is always a string too — it can be a compound
  value like `"6,2"` for `NUMERIC` precision, so it's never parsed as a
  number. There is deliberately no create-connection endpoint: a manifest
  entry can rename/re-point/delete a connection, but a brand-new one has to
  come from wherever connections are actually provisioned server-side.

  - **The manifest is the only editable copy.** `DataConnections/
    {connectionname}.sql` is still written on every sync — it's the server's
    raw auto-generated DDL dump, kept as read-only reference for local AI
    tooling (regenerated on sync/refresh, so it lags a schema edit pushed
    from the manifest until the next one). Editing it does nothing: the
    watcher recognises the folder and logs a skip pointing at the manifest
    instead of trying to interpret it as a design element.
  - **New tables/columns are identified by a missing id.** A `"tables"` entry
    with no `"tableid"` (or a column with no `"attributeid"`) is created —
    `POST`, then the new id is written back into the manifest in place so the
    next save doesn't create it again. An id that doesn't match anything in
    the last-known baseline is left alone and logged, rather than guessed at,
    since that's more likely a stray copy-paste than an intentional create.
  - **Renaming/re-pointing is a same-id edit**: change `tablename`,
    `buildorder`, `description`, a column's fields, or a connection's
    `connectionname`/`databasename`/`comment` while keeping its id, and it's
    pushed as a `PUT`.
  - **Removals are confirmed, not silent.** Unlike `appparams`/`designparams`
    (which never delete anything based on a manifest diff), removing a
    connection, a table, or a column from the manifest is a real, cascading
    `DELETE` — so before any of those run, one modal lists everything about
    to be deleted (including what a connection/table removal cascades into)
    and asks for confirmation. Declining restores the removed entries back
    into the manifest (the server still has them) rather than leaving it out
    of sync; any non-destructive part of the same edit — a rename, a new
    table — still goes through.
  - **`dataconnections` needs a baseline first**, exactly like `appparams`: a
    manifest written before this feature shipped has no baseline to compare
    against, so an edit to it is skipped (and logged) until `Tornado: Refresh
    from Server` runs once.
  - Comparison is field-by-field per connection/table/column, matched by id
    — reformatting or reordering the JSON never looks like a change, and
    `typesize`/the flag-field strings are compared exactly (`"0"` and `""`
    are both real, distinct values, never normalised).
  - Gated by the same `tornado.pushLocalParameterEdits` setting as
    `appparams`/`designparams` — there's no separate toggle.

- **Editing keywords** (`KEYWORD` / `KEYWORDDATA`, `keywordEditor.ts`):
  `Tornado: Edit Keywords`, from the Command Palette or by right-clicking a
  synced app's folder in the Explorer, opens **the extension's only webview** —
  every other editor here is a QuickPick, which can't present a table of up to
  50 value rows. One panel per application (a second invocation reveals the
  open one rather than starting a rival editor with its own unsaved state):
  keywords down the left with New/Delete, and the selected keyword's name plus
  its value rows as an editable table on the right (each row is a `data`
  value and its `keywordorder`, named as the server's columns are).

  - **A row has no order by default.** `keywordorder` starts null on a new
    row (the box shows a "by value" placeholder), and such rows sort by their
    `data`. An order is something a user opts into for the rows they want
    pinned. Clearing the box returns a row to unordered — it does *not* mean
    zero, which is a real order like any other.
  - Rows carrying an explicit order come first, in that order; the rest follow
    sorted by `data`. Ties on order fall back to `data`. Sorting is applied on
    load and after a save, never while typing, which would make rows jump
    under the cursor.
  - **Order values are preserved, never renumbered.** The order column is
    saved exactly as typed, gaps and duplicates included. The ↑/↓ buttons
    *swap the two rows' order values* rather than renumbering the list, so the
    numbers only ever change as the direct result of an action. Rows that
    share an order value — or that have no order to swap — therefore can't be
    rearranged that way, and the panel says so instead of doing nothing.
  - The `n of 50 rows` counter and the disabled "Add row" past 50 are a
    **guide, not a limit**: nothing blocks a save on row count, so a keyword
    that already holds more than 50 rows server-side stays editable.
  - Edits are kept per keyword for as long as the panel is open, so switching
    between keywords never discards work in progress; unsaved keywords carry a
    dot in the list, Revert restores the last loaded copy, and closing the
    panel with edits pending warns that they were discarded (a webview can't
    veto its own close).
  - Deleting a keyword goes through the same modal confirmation as deleting a
    design element from the server. `description` isn't editable in the panel
    but is carried through the save untouched, since the `PUT` replaces the
    whole keyword.
  - The panel holds no credentials and makes no requests: it exchanges
    messages with the extension, which owns every HTTP call. Its
    Content-Security-Policy allows one nonced inline script and inline styles
    and nothing else — no network, no remote resources — and all of its
    content is set through `textContent`/`value` rather than `innerHTML`.

  **The editor's own reads come from the app pull; dedicated endpoints also
  exist for all of it.** Keywords arrive in the existing `GET /vortex/{appid}/`
  alongside `designelements`, and that's what `fetchKeywords()` still uses,
  but a full set of keyword-specific endpoints exists too:

  ```
  GET    /vortex/{appid}/            (the existing app pull)
    -> {..., "designelements": [...],
        "keywords": [{"keywordid": 12, "appid": 7, "name": "Country",
                      "description": "", "keyworddata": [
                        {"keyworddataid": 88, "data": "AU", "keywordorder": 1},
                        {"keyworddataid": 89, "data": "NZ", "keywordorder": null}]}]}

  GET    /vortex/{appid}/keywords          -> {"keywords": [{...}, ...]}
                                           (same wrapped-list shape as the app pull,
                                            consistent with {"dataconnections": [...]})
  GET    /vortex/{appid}/keywords/{kwid}   -> the bare keyword object, {...}
  POST   /vortex/{appid}/keywords          body {"keyword": {...}} (no keywordid)
                                           -> the created keyword, as a bare object
  PUT    /vortex/{appid}/keywords/{kwid}   body {"keyword": {...}}
                                           -> the updated keyword, as a bare object
  DELETE /vortex/{appid}/keywords/{kwid}
  ```

  These all now exist server-side. Request bodies for `POST`/`PUT` stay
  wrapped as `{"keyword": {...}}` — the server-side convention keeps
  single-object request bodies wrapped even where the matching response is
  bare — but every response that carries a single keyword (`GET`-by-id,
  `POST`, `PUT`) is now a bare object, not `{"keyword": {...}}`. The `PUT`
  sends the whole keyword:
  its `keyworddata` array replaces what's stored, so a deleted row is
  expressed by its absence, and rows carry `keyworddataid` only when they
  already exist.

  **`keywordorder` is always present and is `null` when the row has no
  explicit order** — the key is never omitted, so the server never has to
  guess whether a missing field means "no order" or "leave it alone". Store
  that null as SQL `NULL` (not `0`, which is a legitimate order a user can
  type). On the read side the client accepts `null`, an absent key, or an
  empty string as "no order", and coerces a numeric string to a number.

  What the client actually *parses*: only the `POST` response, via
  `unwrapKeyword()` (also used by `fetchKeyword()`, the client's
  `GET`-by-id method) — it takes the bare object the server now sends, and
  still falls back to unwrapping `{"keyword": {...}}` as tolerance for the
  wrapped shape create responses used before the contract settled on bare. It
  has to be JSON (an empty 200 fails), carrying a `keywordid` — a number, or
  a numeric string, since an id serialised from a Java long often arrives
  quoted. Nothing else in it is required: the editor re-reads the app
  immediately afterwards, so `{"keywordid": 412}` is enough. `PUT` and
  `DELETE` responses are never read by this client — any 2xx is success, an
  empty body is fine, and a non-2xx surfaces its status plus the first 500
  characters of its body. When a `POST` reply can't be used, the error quotes
  the first 300 characters of what actually came back, since a 200 with the
  wrong shape isn't otherwise logged.

  The keyword array is located in the app pull by `extractKeywords()` — by
  shape (objects with `name` and `keyworddata`, which `designelements` can't
  satisfy) or by a keyword-ish key name, so it survives the exact key being
  something other than `keywords`. A response with **no** keyword array is not
  an error: an app can simply have none. A keyword whose rows arrive under
  some *other* name (e.g. a pre-rename `values`) renders as a keyword with no
  values and logs a line naming the keys it did see — **do not save such a
  keyword**, since saving would write that emptiness back. Keywords are
  fetched live and are never synced to disk or recorded in the manifest.

  Note that the app pull carries every design element's base64 content, so
  opening the editor (and each reload after a save) is a heavy request for a
  small amount of data. If that ever bites on a large application, switching
  `fetchKeywords()` to the lightweight `GET /vortex/{appid}/keywords` above is
  the fix — it's the only place that would change.

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
  `tornado/.lib/<connectionId>/` (shared across every app synced from that
  connection). This happens automatically on every sync/refresh
  (`syncDesignToFolder()` in `extension.ts`, non-fatal if it fails, so a
  server without these endpoints doesn't break a normal file sync), not
  only lazily on first compile, so the classpath is warm as soon as an app
  is connected. Clicking an app in the Inventory tree (`Tornado: Sync
  Application to Workspace`) and `Tornado: Refresh from Server` both force a
  fresh download rather than reusing the cache, so an app being opened or
  refreshed never silently runs against last session's jars; `Tornado:
  Create Application`'s sync half still reuses the cache if present, for a
  faster first-time create. `Tornado: Refresh Server Libraries` forces a
  fresh copy on demand, without touching any app's design elements.
  `tornado.compileClasspath` (a settings array, empty by default) can add
  extra jar/directory paths on top of the server-provided ones if needed.

  If the shared libraries zip has a `CLAUDE.md` and/or `AGENTS.md` at its
  root, they're mirrored into the root of every app folder synced from that
  connection (`copyAgentInstructionFiles()` in `javaCompiler.ts`) — guidance
  for AI coding assistants working in the app folder, whichever agent is in
  use. This is a one-way copy, not a design element: re-run on every sync/
  compile/refresh (not only when the zip is freshly downloaded), so a local
  edit is silently overwritten the next time round. The watcher explicitly
  skips both filenames (`AGENT_INSTRUCTION_FILENAMES` in `designSync.ts`), so
  neither is ever uploaded. These are the app-root copies — a `CLAUDE.md` that
  exists as a Documentation *design element* on the server is a different
  thing, synced to `Documentation/CLAUDE.md` like any other element.

  The `java` launcher used to run `ecj` is located via `tornado.javaHome`
  (a setting, empty by default), then `$JAVA_HOME`, then `java` on `PATH`.
  Compiled bytecode's target version (`--release`) comes from
  **`Documentation/devconfig.json`** (`{ "javaVersion": "..." }`).
  `tornado.javaRelease` is only the fallback when that file is missing or
  doesn't set `javaVersion`. This exists because the server doesn't expose the
  Java version it expects via REST the way `vortex-cli-mirror` reads it over
  SOAP; adjust the per-app file if compilation rejects the release, or if
  uploaded classes fail to load on the server.

  **`devconfig.json` is a real Documentation design element, stored on the
  server** (`ensureDevConfig()` in `designSync.ts`), so a whole team shares
  one per-app configuration instead of each checkout inventing its own:

  - When the application has one, it arrives with the rest of the design like
    any other element, lands in the manifest, and is never overwritten with a
    local default.
  - When it doesn't, the default (seeded from `tornado.javaRelease`, default
    `"8"`, a conservative floor) is written locally **and pushed to the
    server** as a new Documentation element, with the new `designbucketid`
    recorded in the manifest.
  - That push is best-effort: a server that rejects it (no permission, or an
    older build) leaves the local copy in place and logs the reason to the
    Tornado output channel rather than failing the sync.
  - Once tracked, local edits upload like any other element. The watcher skips
    it only on *create*, which is reached only when the push didn't succeed —
    retrying that as an incidental file creation isn't the watcher's job. It's
    also kept out of the design-element property editors: it's the extension's
    own configuration, and renaming it would just break the lookup that reads
    it.

  After compiling, each resulting top-level class is matched back to its
  manifest entry by class name. ecj batch-compiles every source together on
  every run (they can reference each other), so a save that only touched
  one file still recompiles all of them — but each one is only uploaded if
  its compiled bytecode or its current `.java` text actually differs from
  what was last successfully uploaded for it: a SHA-256 hash of both is
  kept as `uploadedHash` on the element's manifest entry, purely a local
  record (never sent to the server, never touched by the manual-manifest-
  edit param push described above), and cleared by a fresh sync/refresh —
  so the first compile after one re-uploads once per touched element and
  tracks incrementally from there. When it does upload, it's the same
  `PUT /vortex/{appid}/design/{designbucketid}` used elsewhere, with both
  `designdata` (the compiled bytecode) and `designsource` (the current
  `.java` text) refreshed in the same request, so both server-side fields
  stay in sync rather than just the bytecode.

  Nested/inner/anonymous classes (any `.class` file with `$` in its name,
  e.g. `Outer$Inner.class`) have no `.java` of their own to match a manifest
  entry by name, so they're deployed separately as SharedCode design
  elements (designtype 4), with the same unchanged-skip behaviour: updated
  in place if a same-named SharedCode element already exists and its
  bytecode changed, or created via `POST /vortex/{appid}/design` the first
  time one is seen, with the new `designbucketid` recorded in the manifest.
  Only `designdata` (the bytecode) is sent — there's no source to put in
  `designsource`. On sync, these come back down as a plain `.class` file
  (never a `.java`), so they're never mistaken for a real source file and
  fed back into `ecj`.

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

  **Per-file status**: every compile (manual or auto-compile-on-save)
  badges each `Actions`/`SharedCode`/`ScheduledActions` `.java` file green
  or red in the Explorer (`JavaCompileStatusProvider`, a
  `FileDecorationProvider`), and ecj's actual diagnostics (not just which
  files failed) are parsed out of its output and published to VS Code's
  native Problems panel and as editor squiggles (`vscode.DiagnosticCollection`,
  source `"Tornado (ecj)"`) — so a broken file, and *why* it's broken, is
  visible without hunting through the output channel or waiting to hit the
  `-proceedOnError` stub's `java.lang.Error` at runtime on the server.
  `Tornado: Compile Health Check` reads that same recorded status for a
  chosen app — it does **not** trigger a new compile — and lists any
  currently-errored classes in a QuickPick, each with its ecj message(s) as
  the item detail; picking one opens it. If the app hasn't been compiled
  this session yet, it says so instead of reporting a false "no errors."
  Diagnostics only cover what ecj reports at the *token* it's pointing
  at — the squiggle spans the whole reported line rather than the exact
  token, since reproducing ecj's caret-line column math reliably wasn't
  worth it for a still-correctly-positioned marker.

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
  classpath or project shape for them: framework types like `ActionRunner`
  show as "cannot be resolved to a type", and a static field in one
  `SharedCode` class can fail to resolve from an `Actions` class, even
  though compilation works fine either way. Every sync/refresh that
  downloads server jars also adds `tornado/.lib/**/*.jar` — plus an explicit
  entry for each jar found directly under that app's own `SharedCode/`,
  which the glob doesn't reach — to the workspace's
  `java.project.referencedLibraries` setting, and adds that app's `Actions`,
  `SharedCode`, and `ScheduledActions` folders to `java.project.sourcePaths`
  (all merged in, not overwritten, and only once each — existing entries
  are left alone). `Tornado: Compile & Upload Java` and auto-compile-on-save
  also run this same step (`compileAndUploadFolder()`) — not just
  sync/refresh — so an app synced before this wiring existed (or before it
  needed more source folders than it had at the time) still gets configured
  the next time it's compiled, rather than needing an explicit re-sync.
  Requires the `redhat.java` extension to be installed; if it isn't, this is
  skipped with a note in the "Tornado" output channel rather than failing.
  The Java language server can need a reload or "Java: Clean the Java
  Language Server Workspace" to pick up newly-added entries — the extension
  prompts for that the first time it adds one.

Open decision: whether `tornado/` should be git-ignored (a local sync
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
