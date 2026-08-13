import * as vscode from "vscode";
import { Keyword, KeywordData, NewKeywordPayload, TornadoClient } from "./tornadoClient";
import { logError } from "./logging";

// A guide, not a limit: the editor stops offering new rows past this, but a
// keyword that already holds more is still perfectly editable and saveable.
// Refusing to save data the server already has would trap the user in a panel
// with no way out.
export const KEYWORD_DATA_SOFT_LIMIT = 50;

export function hasOrder(row: KeywordData): boolean {
  return typeof row.keywordorder === "number" && Number.isFinite(row.keywordorder);
}

// Display order: rows carrying an explicit keywordorder come first, in that
// order; everything else follows, sorted by data. Sorting by data is the
// default — an order is the exception a user opts into for the rows they care
// about, so those rows rise to the top rather than being interleaved with
// rows whose position was never stated. Applied on load and after a save —
// never while typing, which would make rows jump under the cursor.
export function sortKeywordData(rows: KeywordData[]): KeywordData[] {
  return [...rows].sort((a, b) => {
    const aOrdered = hasOrder(a);
    const bOrdered = hasOrder(b);
    if (aOrdered && bOrdered) {
      return (a.keywordorder as number) - (b.keywordorder as number) || a.data.localeCompare(b.data);
    }
    if (aOrdered !== bOrdered) {
      return aOrdered ? -1 : 1;
    }
    return a.data.localeCompare(b.data);
  });
}

export function sortKeywords(keywords: Keyword[]): Keyword[] {
  return [...keywords].sort((a, b) => a.name.localeCompare(b.name));
}

// Moving a row swaps its order *value* with its neighbour's, rather than
// renumbering the list — so the numbers only ever change as the direct result
// of an action, and what's stored stays what was typed. Two rows can't be
// reordered this way when they share an order value (swapping equal numbers
// changes nothing) or when either has no order at all (there's nothing to
// swap, and inventing one would be the renumbering this deliberately avoids).
// The caller reports that rather than silently doing nothing.
export function swapRowOrder(
  rows: KeywordData[],
  index: number,
  direction: -1 | 1,
): { rows: KeywordData[]; moved: boolean } {
  const target = index + direction;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) {
    return { rows, moved: false };
  }
  if (!hasOrder(rows[index]) || !hasOrder(rows[target])) {
    return { rows, moved: false };
  }
  if (rows[index].keywordorder === rows[target].keywordorder) {
    return { rows, moved: false };
  }
  const next = rows.map((row) => ({ ...row }));
  const swap = next[index].keywordorder;
  next[index].keywordorder = next[target].keywordorder;
  next[target].keywordorder = swap;
  return { rows: sortKeywordData(next), moved: true };
}

// Every reason this keyword can't be saved, as messages for the panel's error
// banner. Empty means it's good to send.
export function validateKeyword(keyword: Keyword, allKeywords: Keyword[]): string[] {
  const issues: string[] = [];
  const name = keyword.name.trim();
  if (!name) {
    issues.push("The keyword needs a name.");
  } else if (
    allKeywords.some(
      (other) =>
        other.keywordid !== keyword.keywordid && other.name.trim().toLowerCase() === name.toLowerCase(),
    )
  ) {
    issues.push(`Another keyword in this application is already called "${name}".`);
  }

  keyword.keyworddata.forEach((row, index) => {
    if (!row.data.trim()) {
      issues.push(`Row ${index + 1} has no value.`);
    }
    // No order at all is the normal case — only a stated one has to be a
    // whole number.
    if (row.keywordorder !== null && !Number.isInteger(row.keywordorder)) {
      issues.push(`Row ${index + 1} has a non-whole order ("${row.data || "(empty)"}").`);
    }
  });
  return issues;
}

// An empty order box means the row has no explicit position — null, sorted
// by its data. Note what must NOT happen here: Number(null) and Number("")
// are both 0, so handing these straight to Number() would silently pin every
// unordered row to order 0 instead of leaving it unordered. Anything that
// isn't blank is coerced, and garbage stays NaN for validateKeyword to catch.
function toKeywordOrder(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return Number(value);
}

// Sorted, with every row's value/order coerced to the types the rest of this
// module assumes — rows arrive from the webview as plain JSON.
export function normaliseKeyword(keyword: Keyword): Keyword {
  // A keyword whose keyworddata didn't arrive as an array (a server sending
  // the rows under some other name) must not take the panel down with it —
  // it renders as a keyword with no rows, and the client logs which keys it
  // did see (see fetchApplicationDesign).
  const rows = Array.isArray(keyword.keyworddata) ? keyword.keyworddata : [];
  return {
    ...keyword,
    name: String(keyword.name ?? "").trim(),
    keyworddata: sortKeywordData(
      rows.map((row) => ({
        ...row,
        data: String(row.data ?? ""),
        keywordorder: toKeywordOrder(row.keywordorder),
      })),
    ),
  };
}

// One panel per app folder — a second invocation reveals the open one rather
// than starting a rival editor with its own unsaved state.
const openPanels = new Map<string, vscode.WebviewPanel>();

export async function openKeywordEditor(
  appFolder: vscode.Uri,
  appid: number,
  client: TornadoClient,
  output: vscode.OutputChannel,
): Promise<void> {
  const key = appFolder.toString();
  const existing = openPanels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  const folderLabel = appFolder.fsPath.split("/").pop() ?? appFolder.fsPath;
  const panel = vscode.window.createWebviewPanel(
    "tornadoKeywords",
    `Keywords — ${folderLabel}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openPanels.set(key, panel);

  // The server's copy, refreshed after every successful write so the panel
  // shows exactly what's stored (including ids the server assigned to new
  // rows) rather than what was optimistically sent.
  let keywords: Keyword[] = [];
  // Kept in step with the webview so a close can warn about pending edits —
  // onDidDispose can't cancel a close, so warning afterwards is all there is.
  let dirtyNames: string[] = [];

  const load = async (selectedId?: number): Promise<void> => {
    keywords = sortKeywords(await client.fetchKeywords(appid)).map(normaliseKeyword);
    await panel.webview.postMessage({ type: "load", keywords, selectedId });
  };

  const fail = async (action: string, error: unknown): Promise<void> => {
    const message = (error as Error).message;
    logError(output, `Keyword ${action} failed: ${message}`);
    output.show(true);
    await panel.webview.postMessage({ type: "error", messages: [message] });
  };

  panel.webview.onDidReceiveMessage(async (message: { type: string; [k: string]: unknown }) => {
    switch (message.type) {
      case "ready":
        try {
          await load();
        } catch (error) {
          logError(output, `Could not load keywords: ${(error as Error).message}`);
          output.show(true);
          vscode.window.showErrorMessage(`Could not load keywords: ${(error as Error).message}`);
          panel.dispose();
        }
        return;

      case "dirty":
        dirtyNames = (message.names as string[]) ?? [];
        return;

      case "save": {
        const keyword = normaliseKeyword(message.keyword as Keyword);
        const issues = validateKeyword(keyword, keywords);
        if (issues.length > 0) {
          await panel.webview.postMessage({ type: "error", messages: issues });
          return;
        }
        try {
          await client.updateKeyword(appid, keyword.keywordid, keyword);
          output.appendLine(
            `Saved keyword "${keyword.name}" (id ${keyword.keywordid}, ${keyword.keyworddata.length} value(s)).`,
          );
          await load(keyword.keywordid);
          await panel.webview.postMessage({ type: "saved", keywordid: keyword.keywordid });
        } catch (error) {
          await fail("save", error);
        }
        return;
      }

      case "create": {
        // Native input box rather than an in-panel form: it brings its own
        // live validation, and keeps the webview to the table it exists for.
        const name = await vscode.window.showInputBox({
          title: "New Keyword",
          prompt: "Name for the new keyword",
          ignoreFocusOut: true,
          validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              return "The keyword needs a name.";
            }
            return keywords.some((k) => k.name.trim().toLowerCase() === trimmed.toLowerCase())
              ? `Another keyword in this application is already called "${trimmed}".`
              : undefined;
          },
        });
        if (!name) {
          return;
        }
        const payload: NewKeywordPayload = {
          appid,
          name: name.trim(),
          description: "",
          keyworddata: [],
        };
        try {
          const created = await client.createKeyword(appid, payload);
          output.appendLine(`Created keyword "${created.name}" (id ${created.keywordid}).`);
          await load(created.keywordid);
        } catch (error) {
          await fail("create", error);
        }
        return;
      }

      case "delete": {
        const keywordid = message.keywordid as number;
        const keyword = keywords.find((k) => k.keywordid === keywordid);
        if (!keyword) {
          return;
        }
        // Same modal confirmation as deleting a design element from the
        // server (see appWatcher.ts) — this is not undoable.
        const confirmAction = "Delete from Server";
        const confirmed = await vscode.window.showWarningMessage(
          `Delete the keyword "${keyword.name}" and its ${keyword.keyworddata.length} value(s) from the ` +
            "Tornado server? This cannot be undone.",
          { modal: true },
          confirmAction,
        );
        if (confirmed !== confirmAction) {
          return;
        }
        try {
          await client.deleteKeyword(appid, keywordid);
          output.appendLine(`Deleted keyword "${keyword.name}" (id ${keywordid}).`);
          await load();
        } catch (error) {
          await fail("delete", error);
        }
        return;
      }
    }
  });

  panel.onDidDispose(() => {
    openPanels.delete(key);
    if (dirtyNames.length > 0) {
      vscode.window.showWarningMessage(
        `Keyword editor closed with unsaved changes to ${dirtyNames.join(", ")} — those edits were discarded.`,
      );
    }
  });

  panel.webview.html = keywordEditorHtml(panel.webview);
}

function nonceString(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function keywordEditorHtml(webview: vscode.Webview): string {
  const nonce = nonceString();
  // Everything is inline (no media/ assets, no extra esbuild entry), so the
  // policy allows only this one nonced script and inline styles — no network,
  // no remote resources.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .layout { display: flex; height: 100vh; }
  .sidebar {
    width: 220px; flex: 0 0 220px; display: flex; flex-direction: column;
    border-right: 1px solid var(--vscode-panel-border);
  }
  .sidebar h2, .detail h2 {
    margin: 0; padding: 12px 14px 8px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .08em;
    color: var(--vscode-descriptionForeground);
  }
  #keywordList { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
  #keywordList li {
    padding: 5px 14px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px;
  }
  #keywordList li:hover { background: var(--vscode-list-hoverBackground); }
  #keywordList li.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  #keywordList .count { color: var(--vscode-descriptionForeground); font-size: .9em; }
  #keywordList li.selected .count { color: inherit; opacity: .8; }
  #keywordList .dot { color: var(--vscode-charts-orange, #cca700); }
  .sidebar-actions { padding: 8px 10px; display: flex; gap: 6px; border-top: 1px solid var(--vscode-panel-border); }
  .detail { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .detail-head { padding: 8px 16px 12px; display: flex; gap: 8px; align-items: center; }
  .detail-head label { color: var(--vscode-descriptionForeground); }
  #keywordName { flex: 1; max-width: 380px; }
  input {
    font-family: inherit; font-size: inherit;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px; border-radius: 2px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button {
    font-family: inherit; font-size: inherit;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
  }
  button.icon { background: none; color: var(--vscode-foreground); padding: 2px 6px; border: none; opacity: .75; }
  button.icon:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); opacity: 1; }
  .rows { flex: 1; overflow-y: auto; padding: 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  th {
    text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: .08em; color: var(--vscode-descriptionForeground);
    padding: 4px 6px; position: sticky; top: 0; background: var(--vscode-editor-background);
  }
  td { padding: 2px 6px; }
  td.order { width: 76px; }
  td.order input { width: 100%; }
  td.value input { width: 100%; }
  td.actions { width: 96px; white-space: nowrap; text-align: right; }
  .footer {
    padding: 10px 16px; display: flex; align-items: center; gap: 10px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .footer .spacer { flex: 1; }
  .count-note { color: var(--vscode-descriptionForeground); }
  #banner {
    margin: 0 16px; padding: 8px 10px; border-radius: 2px; display: none;
    background: var(--vscode-inputValidation-errorBackground, rgba(190,60,60,.15));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be3c3c);
  }
  #banner ul { margin: 0; padding-left: 18px; }
  .empty { padding: 24px 16px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="layout">
  <div class="sidebar">
    <h2>Keywords</h2>
    <ul id="keywordList"></ul>
    <div class="sidebar-actions">
      <button id="newKeyword">New</button>
      <button id="deleteKeyword" class="secondary">Delete</button>
    </div>
  </div>
  <div class="detail">
    <div class="detail-head">
      <label for="keywordName">Name</label>
      <input id="keywordName" type="text" spellcheck="false">
    </div>
    <div id="banner"><ul id="bannerList"></ul></div>
    <div class="rows">
      <table>
        <thead><tr><th>Order</th><th>Value</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="emptyState" class="empty"></div>
    </div>
    <div class="footer">
      <button id="addRow">Add row</button>
      <span id="rowCount" class="count-note"></span>
      <span class="spacer"></span>
      <button id="revert" class="secondary">Revert</button>
      <button id="save">Save</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  // The server's copy, and a per-keyword working copy so switching between
  // keywords never throws away edits in progress.
  let serverKeywords = [];
  const working = new Map();
  let selectedId = null;

  const $ = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const serverCopy = (id) => serverKeywords.find((k) => k.keywordid === id);
  const workingCopy = (id) => {
    if (!working.has(id)) {
      const found = serverCopy(id);
      if (!found) return null;
      working.set(id, clone(found));
    }
    return working.get(id);
  };
  const isDirty = (id) =>
    working.has(id) && JSON.stringify(working.get(id)) !== JSON.stringify(serverCopy(id));

  function reportDirty() {
    const names = serverKeywords.filter((k) => isDirty(k.keywordid)).map((k) => k.name);
    vscode.postMessage({ type: "dirty", names: names });
  }

  function showErrors(messages) {
    const banner = $("banner");
    const list = $("bannerList");
    list.replaceChildren();
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      list.appendChild(item);
    }
    banner.style.display = messages.length > 0 ? "block" : "none";
  }

  function renderList() {
    const list = $("keywordList");
    list.replaceChildren();
    for (const keyword of serverKeywords) {
      const item = document.createElement("li");
      if (keyword.keywordid === selectedId) item.className = "selected";
      const label = document.createElement("span");
      label.textContent = keyword.name;
      if (isDirty(keyword.keywordid)) {
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.textContent = " ●";
        dot.title = "Unsaved changes";
        label.appendChild(dot);
      }
      const count = document.createElement("span");
      count.className = "count";
      const rows = (workingCopy(keyword.keywordid) || keyword).keyworddata.length;
      count.textContent = rows === 1 ? "1 value" : rows + " values";
      item.append(label, count);
      item.addEventListener("click", () => {
        selectedId = keyword.keywordid;
        showErrors([]);
        render();
      });
      list.appendChild(item);
    }
  }

  function renderDetail() {
    const keyword = selectedId === null ? null : workingCopy(selectedId);
    const body = $("rows");
    body.replaceChildren();
    $("keywordName").value = keyword ? keyword.name : "";
    $("keywordName").disabled = !keyword;
    $("save").disabled = !keyword;
    $("revert").disabled = !keyword || !isDirty(selectedId);
    $("deleteKeyword").disabled = !keyword;
    $("addRow").disabled = !keyword || keyword.keyworddata.length >= ${KEYWORD_DATA_SOFT_LIMIT};

    if (!keyword) {
      $("emptyState").textContent = serverKeywords.length
        ? "Select a keyword to edit its values."
        : "This application has no keywords yet. Use New to create one.";
      $("rowCount").textContent = "";
      return;
    }
    $("emptyState").textContent = keyword.keyworddata.length
      ? ""
      : "No values yet. Use Add row to create one.";
    $("rowCount").textContent =
      keyword.keyworddata.length + " of ${KEYWORD_DATA_SOFT_LIMIT} rows";

    keyword.keyworddata.forEach((row, index) => {
      const tr = document.createElement("tr");

      const orderCell = document.createElement("td");
      orderCell.className = "order";
      const order = document.createElement("input");
      order.type = "number";
      order.step = "1";
      order.placeholder = "by value";
      order.title = "Leave empty to sort this row by its value";
      order.value = row.keywordorder === null || row.keywordorder === undefined
        ? ""
        : String(row.keywordorder);
      order.addEventListener("input", () => {
        // Empty means "no explicit order", not zero.
        row.keywordorder = order.value === "" ? null : Number(order.value);
        renderList();
        $("revert").disabled = false;
        reportDirty();
      });
      orderCell.appendChild(order);

      const valueCell = document.createElement("td");
      valueCell.className = "value";
      const value = document.createElement("input");
      value.type = "text";
      value.spellcheck = false;
      value.value = row.data;
      value.addEventListener("input", () => {
        row.data = value.value;
        renderList();
        $("revert").disabled = false;
        reportDirty();
      });
      valueCell.appendChild(value);

      const actions = document.createElement("td");
      actions.className = "actions";
      const up = iconButton("↑", "Move up", index === 0, () => move(index, -1));
      const down = iconButton(
        "↓",
        "Move down",
        index === keyword.keyworddata.length - 1,
        () => move(index, 1),
      );
      const remove = iconButton("✕", "Remove row", false, () => {
        keyword.keyworddata.splice(index, 1);
        render();
        reportDirty();
      });
      actions.append(up, down, remove);

      tr.append(orderCell, valueCell, actions);
      body.appendChild(tr);
    });
  }

  function iconButton(glyph, title, disabled, onClick) {
    const button = document.createElement("button");
    button.className = "icon";
    button.textContent = glyph;
    button.title = title;
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  const ordered = (row) => typeof row.keywordorder === "number" && isFinite(row.keywordorder);

  // Mirrors sortKeywordData() in keywordEditor.ts: rows with an explicit
  // order first, then the rest by value.
  function sortRows(rows) {
    rows.sort((a, b) => {
      if (ordered(a) && ordered(b)) {
        return a.keywordorder - b.keywordorder || String(a.data).localeCompare(String(b.data));
      }
      if (ordered(a) !== ordered(b)) return ordered(a) ? -1 : 1;
      return String(a.data).localeCompare(String(b.data));
    });
  }

  // Mirrors swapRowOrder(): swap the two rows' order values, then re-sort.
  // Rows that share an order — or that have none — can't be separated this
  // way, which is said rather than silently ignored.
  function move(index, direction) {
    const keyword = workingCopy(selectedId);
    const target = index + direction;
    const rows = keyword.keyworddata;
    if (target < 0 || target >= rows.length) return;
    if (!ordered(rows[index]) || !ordered(rows[target])) {
      showErrors([
        "Rows without an order are sorted by value — give both rows an order to arrange them by hand.",
      ]);
      return;
    }
    if (rows[index].keywordorder === rows[target].keywordorder) {
      showErrors([
        "Both rows have order " + rows[index].keywordorder + " — give one a different order to reorder them.",
      ]);
      return;
    }
    showErrors([]);
    const swap = rows[index].keywordorder;
    rows[index].keywordorder = rows[target].keywordorder;
    rows[target].keywordorder = swap;
    sortRows(rows);
    render();
    reportDirty();
  }

  function render() {
    renderList();
    renderDetail();
  }

  $("keywordName").addEventListener("input", () => {
    const keyword = workingCopy(selectedId);
    if (!keyword) return;
    keyword.name = $("keywordName").value;
    renderList();
    $("revert").disabled = false;
    reportDirty();
  });

  $("addRow").addEventListener("click", () => {
    const keyword = workingCopy(selectedId);
    if (!keyword) return;
    // No order by default — the row sorts by its value until someone chooses
    // to pin it somewhere.
    keyword.keyworddata.push({ data: "", keywordorder: null });
    render();
    reportDirty();
  });

  $("revert").addEventListener("click", () => {
    working.delete(selectedId);
    showErrors([]);
    render();
    reportDirty();
  });

  $("save").addEventListener("click", () => {
    const keyword = workingCopy(selectedId);
    if (!keyword) return;
    showErrors([]);
    vscode.postMessage({ type: "save", keyword: keyword });
  });

  $("newKeyword").addEventListener("click", () => vscode.postMessage({ type: "create" }));
  $("deleteKeyword").addEventListener("click", () => {
    if (selectedId !== null) vscode.postMessage({ type: "delete", keywordid: selectedId });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "load") {
      serverKeywords = message.keywords;
      // Drop working copies of keywords that no longer exist server-side.
      for (const id of Array.from(working.keys())) {
        if (!serverCopy(id)) working.delete(id);
      }
      const requested = message.selectedId;
      if (requested !== undefined && serverCopy(requested)) {
        selectedId = requested;
      } else if (selectedId === null || !serverCopy(selectedId)) {
        selectedId = serverKeywords.length ? serverKeywords[0].keywordid : null;
      }
      render();
      reportDirty();
      return;
    }
    if (message.type === "saved") {
      // The reload above is authoritative now, so the working copy has
      // nothing left to hold.
      working.delete(message.keywordid);
      showErrors([]);
      render();
      reportDirty();
      return;
    }
    if (message.type === "error") {
      showErrors(message.messages);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
