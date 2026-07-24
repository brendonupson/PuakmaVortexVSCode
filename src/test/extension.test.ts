import * as assert from "assert";
import * as vscode from "vscode";

// require() avoids resolveJsonModule + tsconfig rootDir friction for a value only used here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { publisher, name } = require("../../package.json") as { publisher: string; name: string };

suite("Tornado Extension", () => {
  test("activates and registers commands", async () => {
    const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
    assert.ok(extension, "extension not found");
    await extension!.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "tornado.addConnection",
      "tornado.selectConnection",
      "tornado.editConnection",
      "tornado.deleteConnection",
      "tornado.refreshInventory",
      "tornado.syncApplication",
      "tornado.startWatching",
      "tornado.stopWatching",
      "tornado.refreshFromServer",
      "tornado.compileAndUpload",
      "tornado.refreshServerLibraries",
    ]) {
      assert.ok(commands.includes(command), `${command} not registered`);
    }
  });
});
