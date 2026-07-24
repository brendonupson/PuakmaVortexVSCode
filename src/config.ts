import * as vscode from "vscode";
import { randomUUID } from "node:crypto";

export interface TornadoConnection {
  id: string;
  name: string;
  serverUrl: string;
}

export interface TornadoCredentials {
  username: string;
  password: string;
}

const ACTIVE_CONNECTION_KEY = "tornado.activeConnectionId";

export function getConnections(): TornadoConnection[] {
  return vscode.workspace
    .getConfiguration("tornado")
    .get<TornadoConnection[]>("connections", []);
}

async function setConnections(connections: TornadoConnection[]): Promise<void> {
  // Global scope: connection profiles should be available in every workspace
  // (like SSH/DB client extensions do it), and writable even before any
  // folder is open — Workspace scope requires an open folder and would
  // silently strand connections in whichever folder happened to be open.
  await vscode.workspace
    .getConfiguration("tornado")
    .update("connections", connections, vscode.ConfigurationTarget.Global);
}

export async function addConnection(
  context: vscode.ExtensionContext,
  name: string,
  serverUrl: string,
  credentials: TornadoCredentials,
): Promise<TornadoConnection> {
  const connection: TornadoConnection = { id: randomUUID(), name, serverUrl };
  await setConnections([...getConnections(), connection]);
  await storeCredentials(context, connection.id, credentials);
  await setActiveConnectionId(context, connection.id);
  return connection;
}

export async function updateConnection(
  context: vscode.ExtensionContext,
  id: string,
  name: string,
  serverUrl: string,
  credentials: TornadoCredentials,
): Promise<void> {
  const connections = getConnections();
  const index = connections.findIndex((connection) => connection.id === id);
  if (index === -1) {
    throw new Error(`Connection "${id}" not found.`);
  }
  connections[index] = { id, name, serverUrl };
  await setConnections(connections);
  await storeCredentials(context, id, credentials);
}

export async function removeConnection(
  context: vscode.ExtensionContext,
  id: string,
): Promise<void> {
  await setConnections(getConnections().filter((connection) => connection.id !== id));
  await clearCredentials(context, id);
  if (getActiveConnectionId(context) === id) {
    await setActiveConnectionId(context, undefined);
  }
}

export function getActiveConnectionId(context: vscode.ExtensionContext): string | undefined {
  // globalState (not workspaceState): the active connection should carry
  // over between windows/folders, matching how the connection list itself
  // is now stored globally.
  return context.globalState.get<string>(ACTIVE_CONNECTION_KEY);
}

export async function setActiveConnectionId(
  context: vscode.ExtensionContext,
  id: string | undefined,
): Promise<void> {
  await context.globalState.update(ACTIVE_CONNECTION_KEY, id);
}

export function getActiveConnection(
  context: vscode.ExtensionContext,
): TornadoConnection | undefined {
  const id = getActiveConnectionId(context);
  return id ? getConnections().find((connection) => connection.id === id) : undefined;
}

function credentialKey(connectionId: string, field: "username" | "password"): string {
  return `tornado.credentials.${connectionId}.${field}`;
}

export async function getCredentials(
  context: vscode.ExtensionContext,
  connectionId: string,
): Promise<TornadoCredentials | undefined> {
  const username = await context.secrets.get(credentialKey(connectionId, "username"));
  const password = await context.secrets.get(credentialKey(connectionId, "password"));
  if (!username || !password) {
    return undefined;
  }
  return { username, password };
}

export async function storeCredentials(
  context: vscode.ExtensionContext,
  connectionId: string,
  credentials: TornadoCredentials,
): Promise<void> {
  await context.secrets.store(credentialKey(connectionId, "username"), credentials.username);
  await context.secrets.store(credentialKey(connectionId, "password"), credentials.password);
}

export async function clearCredentials(
  context: vscode.ExtensionContext,
  connectionId: string,
): Promise<void> {
  await context.secrets.delete(credentialKey(connectionId, "username"));
  await context.secrets.delete(credentialKey(connectionId, "password"));
}
