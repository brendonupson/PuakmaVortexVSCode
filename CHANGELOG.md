# Changelog

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
