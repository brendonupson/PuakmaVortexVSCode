import * as vscode from "vscode";
import { InventoryItem, TornadoClient } from "./tornadoClient";

// Tree items don't support arbitrary label colors directly — a
// FileDecorationProvider does, keyed off resourceUri. The "inherited" flag
// is encoded into the URI itself so the provider (registered in
// extension.ts) stays a pure function of the URI, needing no extra state.
export const INHERITED_APP_URI_SCHEME = "tornado-app";

function appResourceUri(item: InventoryItem): vscode.Uri {
  return vscode.Uri.from({
    scheme: INHERITED_APP_URI_SCHEME,
    path: `/${item.appid}`,
    query: item.inheritfrom ? "inherited=1" : "",
  });
}

class AppGroupTreeItem extends vscode.TreeItem {
  constructor(
    groupName: string,
    public readonly items: InventoryItem[],
  ) {
    super(groupName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class InventoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly item: InventoryItem,
    public readonly parent: AppGroupTreeItem,
  ) {
    super(item.appdisplayname || item.appname, vscode.TreeItemCollapsibleState.None);
    this.description = item.appversion;
    const tooltipLines = [item.description || item.appname];
    if (item.inheritfrom !== "") {
      tooltipLines.push(`Inherits from: ${item.inheritfrom}`);
    }
    if (item.templatename !== "") {
      tooltipLines.push(`Is template: ${item.templatename}`);
    }
    this.tooltip = tooltipLines.join("\n");
    // Always set explicitly (rather than only for templates): once
    // resourceUri is set below, VS Code would otherwise guess an icon from
    // the icon theme based on the (extension-less) synthetic URI.
    this.iconPath = new vscode.ThemeIcon(item.templatename !== "" ? "symbol-snippet" : "file");
    this.resourceUri = appResourceUri(item);
    this.command = {
      command: "tornado.syncApplication",
      title: "Sync Application to Workspace",
      arguments: [item],
    };
  }
}

type InventoryTreeNode = AppGroupTreeItem | InventoryTreeItem;

function groupSortedByAppGroupThenName(items: InventoryItem[]): AppGroupTreeItem[] {
  const groups = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.appgroup);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(item.appgroup, [item]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([appgroup, groupItems]) =>
        new AppGroupTreeItem(
          appgroup || "(ungrouped)",
          [...groupItems].sort((a, b) => a.appname.localeCompare(b.appname)),
        ),
    );
}

export class InventoryTreeProvider implements vscode.TreeDataProvider<InventoryTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    InventoryTreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private treeView: vscode.TreeView<InventoryTreeNode> | undefined;

  // The exact AppGroupTreeItem instances the tree view is currently
  // rendering at the root — kept so expandAll() can reveal() the same
  // objects VS Code already has in its model, rather than ones freshly
  // built (and re-fetched from the server) just for the reveal call.
  private lastGroups: AppGroupTreeItem[] = [];

  // The raw inventory behind lastGroups — kept so collapseAll() (see below)
  // can force a full root rebuild without an extra round trip to the server.
  private lastItems: InventoryItem[] | undefined;

  // Set by collapseAll() to make the *next* getChildren(undefined) rebuild
  // fresh AppGroupTreeItem instances from lastItems instead of re-fetching.
  private reuseCache = false;

  constructor(
    private client: TornadoClient | undefined,
    private readonly output: vscode.OutputChannel,
  ) {}

  attachTreeView(treeView: vscode.TreeView<InventoryTreeNode>): void {
    this.treeView = treeView;
  }

  setClient(client: TornadoClient | undefined): void {
    this.client = client;
    if (this.treeView) {
      // Cleared as soon as getChildren resolves; only visible while a
      // connection is active but nothing has loaded (or errored) yet.
      this.treeView.message = undefined;
    }
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: InventoryTreeNode): vscode.TreeItem {
    return element;
  }

  // Required for treeView.reveal(), which expandAll() uses.
  getParent(element: InventoryTreeNode): InventoryTreeNode | undefined {
    return element instanceof InventoryTreeItem ? element.parent : undefined;
  }

  async getChildren(element?: InventoryTreeNode): Promise<InventoryTreeNode[]> {
    if (element instanceof AppGroupTreeItem) {
      return element.items.map((item) => new InventoryTreeItem(item, element));
    }
    if (element || !this.client) {
      return [];
    }
    if (this.reuseCache && this.lastItems) {
      this.reuseCache = false;
      this.lastGroups = groupSortedByAppGroupThenName(this.lastItems);
      return this.lastGroups;
    }
    this.reuseCache = false;
    try {
      const items = await this.client.fetchInventory();
      if (this.treeView) {
        this.treeView.message = undefined;
      }
      this.lastItems = items;
      this.lastGroups = groupSortedByAppGroupThenName(items);
      return this.lastGroups;
    } catch (error) {
      const message = `Failed to load Tornado inventory: ${(error as Error).message}`;
      this.output.appendLine(message);
      if (this.treeView) {
        this.treeView.message = message;
      }
      this.lastGroups = [];
      return [];
    }
  }

  // Expands every appgroup at once, via reveal() on each of the root nodes
  // currently known to the view.
  async expandAll(): Promise<void> {
    if (!this.treeView) {
      return;
    }
    if (this.lastGroups.length === 0) {
      await this.getChildren();
    }
    for (const group of this.lastGroups) {
      await this.treeView.reveal(group, { expand: true, select: false, focus: false });
    }
  }

  // Collapses every appgroup at once. TreeView has no "collapse this node"
  // API — mutating an already-rendered AppGroupTreeItem's collapsibleState
  // and firing a change event *for that element* does nothing observable:
  // the widget's expand/collapse state is its own UI state keyed by node
  // identity, not re-derived from collapsibleState on a per-element
  // refresh (tried, confirmed to silently no-op).
  //
  // What does work: firing onDidChangeTreeData with no element, which makes
  // VS Code discard and rebuild the whole root. Since AppGroupTreeItem sets
  // no explicit `id`, VS Code can't map the old (possibly-expanded) nodes to
  // the freshly-built ones, so every rebuilt group renders at its declared
  // default state (Collapsed) — the same reason a full refresh normally
  // "loses" expand state without ids, deliberately used here rather than
  // fought. `reuseCache` avoids the network round trip a plain refresh()
  // would otherwise trigger, by rebuilding from the last-fetched inventory
  // instead of re-fetching it.
  collapseAll(): void {
    this.reuseCache = true;
    this.refresh();
  }
}
