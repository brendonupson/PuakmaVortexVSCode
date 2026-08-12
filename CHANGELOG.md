# Changelog

## Unreleased

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
