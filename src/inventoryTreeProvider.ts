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
    super(groupName, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class InventoryTreeItem extends vscode.TreeItem {
  constructor(public readonly item: InventoryItem) {
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

  async getChildren(element?: InventoryTreeNode): Promise<InventoryTreeNode[]> {
    if (element instanceof AppGroupTreeItem) {
      return element.items.map((item) => new InventoryTreeItem(item));
    }
    if (element || !this.client) {
      return [];
    }
    try {
      const items = await this.client.fetchInventory();
      if (this.treeView) {
        this.treeView.message = undefined;
      }
      return groupSortedByAppGroupThenName(items);
    } catch (error) {
      const message = `Failed to load Tornado inventory: ${(error as Error).message}`;
      this.output.appendLine(message);
      if (this.treeView) {
        this.treeView.message = message;
      }
      return [];
    }
  }
}
