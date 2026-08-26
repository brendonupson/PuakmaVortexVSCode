# Changelog

## 0.0.8

- Editing `.tornado-manifest.json` directly on disk — e.g. by an AI coding
  agent like Claude Code, rather than through this extension's own UI — now
  pushes the resulting `designparams`/`appparams` changes to the Tornado
  server, the same way the interactive "Edit Parameters" commands do,
  whenever the app's watcher is running. See the README for the full
  contract (which fields are watched, full-replace semantics, and the new
  `tornado.pushLocalParameterEdits` setting to disable it).
- The Inventory view now starts collapsed, and its title bar gained "Expand
  All" and "Collapse All" buttons for its app groups.

## 0.0.7

- Data connections are now synced to disk: opening/syncing an app writes each
  of its data connections' schema dumps to `tornado/{app}/DataConnections/
  {connectionname}.sql`, so the raw JDBC connection info is available locally
  (e.g. for AI tooling) instead of only ever visible through the server's own
  design endpoint.

## 0.0.6

- The activity bar icon is now a proper vector head icon instead of the
  placeholder funnel shape.
- Java design elements (Actions/SharedCode/ScheduledActions) now get a
  green or red "J" badge in the Explorer after each compile, based on
  whether ecj reported an error for that specific source — no need to open
  the Tornado output channel to see which file is broken.

## 0.0.5

- Everything the extension logs is now mirrored to `console.log`, so it shows
  up in the **Debug Console** when running under F5 (and in Help > Toggle
  Developer Tools otherwise) instead of only in the Output panel, with a
  timestamp on each line. Every command invocation is traced — what ran, what
  it was aimed at, whether it finished, and how long it took.
- **Failures are shown in red**: the "Tornado" channel is now a
  `LogOutputChannel` and failures go through its `error()` level, while the
  Debug Console mirror uses `console.error`. That covers failed
  uploads/downloads (any non-2xx or network error from the server), compile
  diagnostics from ecj, unexpected response shapes, watcher errors, and any
  command that throws.
- Fixed: design elements whose server-side name already carries an extension
  (Resources, Documentation, Widgets) were written to disk with it doubled —
  `Documentation/CLAUDE.md` became `CLAUDE.md.md`, a resource `style.css`
  became `style.css.css`. The local filename is now derived by `fileNameFor()`
  in `designSync.ts`, the exact inverse of `serverNameFor()`, so a
  download/upload round trip leaves the server-side name untouched.
- `Documentation/devconfig.json` is now a real design element rather than a
  local-only file: it's pulled from the server when the application has one,
  and when it doesn't, the default is written locally *and pushed* so everyone
  syncing that app shares one configuration. Pushing is best-effort — a server
  that rejects it leaves the local copy in place and logs why rather than
  failing the sync.
- Opening an app from the Inventory tree now replaces the local folder
  instead of writing over the top of it, so elements deleted on the server
  don't linger locally. A modal confirmation comes first when the folder
  isn't empty, with "Delete & Sync Fresh", "Sync Without Deleting" (the
  previous behaviour) and Cancel. The app's watcher is stopped before the
  delete — otherwise it would treat the wipe as local deletions and ask
  whether to delete each element from the server — and restarted afterwards;
  the folder goes to the OS trash where supported; and
  `Documentation/devconfig.json` is preserved across the replace.
- Fixed: Tornado commands appeared in the Explorer context menu on folders
  and files they can't act on, and failed with an error when used there. The
  three application-level commands (Edit Application Properties/Parameters,
  Edit Keywords) now appear only on an application's own root folder, not on
  its design-type subfolders, `zbin/`, the shared `.lib/` cache, or
  `tornado/` itself. Edit Design Element Properties now appears only on a
  file actually inside a design-type folder, so it's no longer offered on
  `CLAUDE.md`/`AGENTS.md`, `.tornado-manifest.json`, compiled `zbin/` output
  or cached jars.

## 0.0.4

- New "Tornado: Edit Keywords" command (Command Palette or Explorer
  right-click on a synced app folder): a webview panel — the first in this
  extension — listing the application's keywords with New/Delete, and the
  selected keyword's values as an editable table of `data`/`keywordorder`
  rows. A row has no
  `keywordorder` by default (sent as an explicit `null`) and sorts by its
  `data`; rows given an order come first, in that order. Order numbers are
  saved exactly as typed and never renumbered (↑/↓ swap two rows' order
  values instead). The
  50-row counter is a guide, not a save-blocking limit. Edits are kept per
  keyword while the panel is open, so switching keywords doesn't discard work.
  Keywords are read out of the existing app pull (`GET /vortex/{appid}/`,
  alongside `designelements`, each keyword carrying its rows as
  `keyworddata`); writes go to `POST /vortex/{appid}/keywords` and
  `PUT`/`DELETE /vortex/{appid}/keywords/{keywordid}` with bodies wrapped as
  `{"keyword": {...}}` — write endpoints that do not exist server-side yet.

- New "Tornado: Edit Application Parameters" command (Command Palette or
  Explorer right-click on a synced app folder): edits an application's
  `APPPARAM` key/value pairs, with Actions, Pages, and locales picked from
  lists and the `1`-or-absent flags toggled rather than typed. Parameters the
  app has beyond the ten well-known names are shown and editable too. Reads
  and writes via `GET`/`PUT /vortex/{appid}/appparams`, a collection of its
  own, so nothing outside the parameters is touched. The `PUT` body is
  `{"appparams": [...]}`.
- New "Tornado: Edit Design Element Parameters" command (Command Palette or
  Explorer right-click on a design element file): edits an element's
  `designparams`. Only Pages, Resources and Actions have editable parameters
  — SharedCode, Documentation, ScheduledActions and Widgets don't offer the
  command at all. For the rest, the parameter list follows the design type —
  every type has the
  `AnonymousAccess`/`MinifyLevel`/`CompositeElement` flags, and a Page also
  has `OpenAction`/`SaveAction` (picked from Actions) and `ParentPage`
  (picked from Pages). Reads and writes via `GET`/`PUT
  /vortex/{appid}/design/{designbucketid}/params` (body `{"designparams":
  [...]}`), with the manifest's copy of the parameters updated so the watcher
  can't revert them on the next file save.
- Every request with a body now logs that body's size (and the body itself,
  when under 2KB) to the Tornado output channel, so "the server received no
  data" can be told apart from "the client sent none".

## 0.0.3

- Local sync folder renamed from the hidden `.tornado/` to a visible
  `tornado/`, so app folders are reachable without unhiding dotfiles.
- If the server's shared libraries zip includes a `CLAUDE.md` and/or
  `AGENTS.md`, they're mirrored into the root of every synced app folder
  (kept in sync on every sync/compile/refresh; local edits aren't uploaded
  and are overwritten the next time round).
- Syncing, creating, and refreshing an application now show a progress
  notification titled with the app's `/appgroup/appname`, so background
  downloads triggered by clicking multiple apps are visible instead of
  running silently.
- Nested/inner/anonymous compiled Java classes (`Foo$Bar.class`) are
  uploaded as SharedCode design elements instead of being silently dropped.
- New "Tornado: Edit Design Element Properties" and "Tornado: Edit
  Application Properties" commands (Command Palette or Explorer
  right-click), plus a "Tornado: Create Application" command.
- Trimmed the packaged extension size for Marketplace publishing (smaller
  icon, dev-only files excluded from the `.vsix`).

## 0.0.1

- Initial skeleton: connection configuration, inventory tree view (stub), and
  local design-element folder creation (stub).
- Connection configuration now supports multiple named connections
  (add/select/remove), each with its own URL and credentials.
