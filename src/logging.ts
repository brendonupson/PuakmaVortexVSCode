import * as vscode from "vscode";

// Two audiences for the same stream:
//
//  - The "Tornado" output channel, created as a LogOutputChannel so entries
//    carry a level. Failures go through error(), which the Output panel
//    renders in red rather than as one more indistinguishable line.
//  - console.log/console.error, which is where the Debug Console shows this
//    when the extension runs under F5 (and Help > Toggle Developer Tools in a
//    normal install) — so a debugging session sees extension activity
//    interleaved with its own breakpoints and stack traces.
//
// Only what's already written to the channel is mirrored: design element
// *contents* (base64) are never logged, just names and byte counts.

export interface TornadoOutputChannel extends vscode.OutputChannel {
  error(message: string): void;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}`
  );
}

export function createOutputChannel(name = "Tornado"): TornadoOutputChannel {
  const channel = vscode.window.createOutputChannel(name, { log: true });

  // append() writes without a trailing newline, so partial text is buffered
  // and mirrored only once a full line exists — otherwise one logical line
  // would reach the Debug Console as several fragments.
  let pending = "";
  const mirror = (text: string, complete: boolean, isError: boolean): void => {
    pending += text;
    const lines = pending.split("\n");
    pending = complete ? "" : (lines.pop() ?? "");
    if (complete && lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    for (const line of lines) {
      const rendered = `[${timestamp()}] [${name}] ${line}`;
      // console.error is what makes it red in the Debug Console.
      if (isError) {
        console.error(rendered);
      } else {
        console.log(rendered);
      }
    }
  };

  return {
    name: channel.name,
    append(value: string): void {
      channel.append(value);
      mirror(value, false, false);
    },
    appendLine(value: string): void {
      // info() rather than the inherited appendLine(): on a log channel it's
      // the documented way to emit at a level, which is what gives error()
      // below something to stand out against.
      channel.info(value);
      mirror(`${value}\n`, true, false);
    },
    error(message: string): void {
      channel.error(message);
      mirror(`${message}\n`, true, true);
    },
    replace(value: string): void {
      channel.replace(value);
      mirror(`${value}\n`, true, false);
    },
    clear(): void {
      channel.clear();
    },
    show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
      (channel.show as (a?: unknown, b?: unknown) => void)(columnOrPreserveFocus, preserveFocus);
    },
    hide(): void {
      channel.hide();
    },
    dispose(): void {
      channel.dispose();
    },
  };
}

// Logs a failure in red where the channel supports it. Takes a plain
// OutputChannel (optional, since TornadoClient's is) so every module can
// report failures without threading a more specific type through its
// signatures; falls back to a normal line if it isn't one of ours.
export function logError(output: vscode.OutputChannel | undefined, message: string): void {
  if (!output) {
    return;
  }
  const channel = output as Partial<TornadoOutputChannel>;
  if (typeof channel.error === "function") {
    channel.error(message);
  } else {
    output.appendLine(message);
  }
}

// Wraps a command handler so every invocation is traced: which command ran,
// what it was aimed at, whether it finished or threw, and how long it took.
// The commands log their own milestones; this is the frame around them, so
// the Debug Console shows the shape of what happened even for a command that
// completes without saying anything.
export function traceCommand<A extends unknown[]>(
  output: vscode.OutputChannel,
  id: string,
  handler: (...args: A) => unknown,
): (...args: A) => Promise<unknown> {
  return async (...args: A): Promise<unknown> => {
    const target = describeArg(args[0]);
    const started = Date.now();
    output.appendLine(`▶ ${id}${target ? ` (${target})` : ""}`);
    try {
      const result = await handler(...args);
      output.appendLine(`✔ ${id} — ${Date.now() - started}ms`);
      return result;
    } catch (error) {
      // Re-thrown: this observes, it doesn't change how a failing command
      // behaves. Commands report their own errors to the user; VS Code logs
      // anything that escapes.
      logError(
        output,
        `✘ ${id} — ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  };
}

// A command's first argument says what it was aimed at: a Uri from an
// Explorer right-click, an inventory item from the tree, or nothing at all
// from the Command Palette.
function describeArg(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const candidate = arg as { fsPath?: unknown; appname?: unknown; appid?: unknown };
  if (typeof candidate.fsPath === "string") {
    return candidate.fsPath;
  }
  if (typeof candidate.appname === "string") {
    return candidate.appid === undefined
      ? candidate.appname
      : `${candidate.appname} (appid ${String(candidate.appid)})`;
  }
  return undefined;
}
