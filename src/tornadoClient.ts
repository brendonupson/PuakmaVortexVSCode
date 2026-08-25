import * as vscode from "vscode";
import { logError } from "./logging";

export interface InventoryItem {
  appid: number;
  appname: string;
  appdisplayname?: string;
  appgroup: string;
  description: string;
  templatename: string;
  appversion?: string;
  inheritfrom: string;
}

// appid doesn't exist yet — used as the POST body when creating a new
// application, mirroring NewDesignElementPayload below.
export type NewApplicationPayload = Omit<InventoryItem, "appid">;

export interface DesignParam {
  paramname: string;
  paramvalue: string;
}

// An application-level parameter (APPPARAM) — same shape as DesignParam, but
// scoped to the application rather than one of its design elements.
export interface AppParam {
  paramname: string;
  paramvalue: string;
}

// The keys the two parameter collections are written under (see
// updateApplicationParams / updateDesignParams). DESIGN_PARAMS_KEY matches
// the field name design elements already use in their own JSON, rather than
// the "params" of its URL.
export const APP_PARAMS_KEY = "appparams";
export const DESIGN_PARAMS_KEY = "designparams";

// One value of a keyword's lookup list (KEYWORDDATA), named as the server
// names its columns: "data" holds the value, "keywordorder" its position.
// keyworddataid is absent on a row added in the editor and not yet saved —
// the server assigns it.
//
// keywordorder is null when the row has no explicit position, which is the
// default for a new row: unordered rows sort by their data. It is always
// *sent* as an explicit null rather than by omitting the key, so the server
// never has to tell "no order" apart from "field missing".
export interface KeywordData {
  keyworddataid?: number;
  data: string;
  keywordorder: number | null;
}

// An application's named lookup list (KEYWORD).
export interface Keyword {
  keywordid: number;
  appid: number;
  name: string;
  description: string;
  keyworddata: KeywordData[];
}

// keywordid doesn't exist yet — the POST body when creating a keyword, the
// same way NewDesignElementPayload works for design elements.
export type NewKeywordPayload = Omit<Keyword, "keywordid">;

// Keyword bodies are wrapped under this key for the same reason the parameter
// collections are: a bare top-level array goes out on the wire correctly but
// the server reads no data from it.
export const KEYWORD_KEY = "keyword";

// Pulls an array out of whatever a collection endpoint returns: an object
// wrapping it under a key (what the PUTs send, and how the design endpoint
// wraps its elements under "designelements"), or a bare top-level array.
// Tolerant on read, exact on write.
//
// Content first — an array whose first element has the expected fields is
// unambiguous. An empty array has nothing to shape-match, so the second pass
// falls back to the key's *name*, which is why callers pass a pattern too.
function extractArray<T>(
  body: unknown,
  looksRight: (first: Record<string, unknown>) => boolean,
  keyPattern: RegExp,
): T[] | undefined {
  if (Array.isArray(body)) {
    return body as T[];
  }
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const entries = Object.entries(body as Record<string, unknown>);
  for (const [, value] of entries) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0] as Record<string, unknown> | null;
      if (first && typeof first === "object" && looksRight(first)) {
        return value as T[];
      }
    }
  }
  for (const [key, value] of entries) {
    if (Array.isArray(value) && keyPattern.test(key)) {
      return value as T[];
    }
  }
  return undefined;
}

// Exported for testability.
export function extractParams<T extends AppParam | DesignParam>(body: unknown): T[] | undefined {
  return extractArray<T>(
    body,
    (first) => "paramname" in first && "paramvalue" in first,
    /param/i,
  );
}

export function extractKeywords(body: unknown): Keyword[] | undefined {
  return extractArray<Keyword>(body, (first) => "name" in first && "keyworddata" in first, /keyword/i);
}

// A named server-side JDBC data source (DATACONNECTION), carried alongside
// a specific app's design pull (not the top-level /vortex inventory) purely
// as reference metadata — Vortex2 never opens or queries it. "schema" is the
// raw auto-generated DDL dump the server logs for it, including any
// connection error it hit while generating it.
export interface DataConnection {
  connectionname: string;
  databasename: string;
  schema: string;
  comment: string;
}

export function extractDataConnections(body: unknown): DataConnection[] | undefined {
  return extractArray<DataConnection>(
    body,
    (first) => "connectionname" in first && "schema" in first,
    /dataconnection/i,
  );
}

// A single keyword from a create response: the wrapped {"keyword": {...}} the
// PUT/POST bodies use, or the bare object. Exported for testability.
export function unwrapKeyword(body: unknown): Keyword | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if ("keywordid" in record || "name" in record) {
    return record as unknown as Keyword;
  }
  const wrapped = record[KEYWORD_KEY];
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    return wrapped as Keyword;
  }
  return undefined;
}

export interface DesignElement {
  designbucketid: number;
  appid: number;
  name: string;
  designtype: number;
  contenttype: string;
  designdata: string | null; // base64 — null when unused for this element's type
  designsource: string | null; // base64 — null when unused for this element's type
  inheritfrom: string | null;
  comment: string;
  options: string;
  updatedby: string;
  updated: string;
  designparams: DesignParam[];
}

export interface ApplicationDesign {
  designelements: DesignElement[];
  // Keywords ride along in the same app pull as the design elements — there's
  // no separate read endpoint for them. Empty when the response carries no
  // keyword array at all, which is not an error: an app can simply have none.
  keywords: Keyword[];
  // Data connections ride along the same way — the full /vortex inventory
  // does NOT carry them; they only show up once a specific app is opened.
  // Empty when the response carries none, same reasoning as keywords.
  dataconnections: DataConnection[];
}

// Same shape as a downloaded DesignElement, minus the server-managed audit
// fields — used as the PUT body when updating an existing element.
export type DesignElementPayload = Omit<DesignElement, "updatedby" | "updated">;

// designbucketid doesn't exist yet — used as the POST body when creating a
// new element. The server is assumed to respond with the full created
// DesignElement (including its new designbucketid); unverified against a
// real request, see TornadoClient.createDesignElement.
export type NewDesignElementPayload = Omit<DesignElementPayload, "designbucketid">;

export class TornadoClient {
  constructor(
    private readonly serverUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly output?: vscode.OutputChannel,
  ) {}

  private buildAuthHeader(): string {
    const token = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return `Basic ${token}`;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.serverUrl.replace(/\/$/, "")}${path}`;
    const method = init?.method ?? "GET";
    // Log the request body's size (and, when it's small, the body itself) —
    // "the server received no data" is otherwise indistinguishable from
    // "the client sent none". Bodies here are either JSON or base64-encoded
    // file content, so a size alone is enough for the big ones.
    if (typeof init?.body === "string") {
      const bytes = Buffer.byteLength(init.body);
      this.output?.appendLine(
        `→ ${method} ${url} — ${bytes} byte body` + (bytes <= 2000 ? `: ${init.body}` : ""),
      );
    } else {
      this.output?.appendLine(`→ ${method} ${url}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: this.buildAuthHeader(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(this.output, `✘ ${method} ${url} — network error: ${message}`);
      throw new Error(`Could not reach ${url}: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // A failed upload or download — logged as an error so it stands out in
      // red rather than scrolling past as one more line.
      logError(
        this.output,
        `✘ ${method} ${url} — ${response.status} ${response.statusText}` +
          (body ? `\n${body.slice(0, 2000)}` : ""),
      );
      throw new Error(
        `Tornado server responded with ${response.status} ${response.statusText} for ${method} ${url}` +
          (body ? `: ${body.slice(0, 500)}` : ""),
      );
    }
    this.output?.appendLine(`✔ ${method} ${url} — ${response.status}`);
    return response;
  }

  async fetchInventory(): Promise<InventoryItem[]> {
    const response = await this.request("/vortex");
    const items = (await response.json()) as InventoryItem[];
    this.output?.appendLine(`  ${items.length} app(s) in inventory`);
    return items;
  }

  // Endpoint, method, and payload shape are extrapolated from the
  // established design-element pattern (GET reads it, PUT with the same
  // shape updates it) — there's no confirmed spec for updating an
  // application's own properties anywhere in this codebase, unlike the
  // design-element endpoints below, which the reference vortex-cli-mirror
  // tool corroborates. Genuinely unverified against a real server; if the
  // Tornado server doesn't accept this, this is the first place to check.
  async updateApplication(appid: number, payload: InventoryItem): Promise<void> {
    await this.request(`/vortex/${appid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // Same extrapolation as updateApplication() above, mirrored onto the
  // create side the way createDesignElement() mirrors updateDesignElement()
  // — POST to the collection endpoint, server assumed to respond with the
  // full created item (to learn its new appid). Genuinely unverified
  // against a real server; fails loudly rather than silently creating a
  // local folder with no server-side appid to sync against if the response
  // shape doesn't match.
  async createApplication(payload: NewApplicationPayload): Promise<InventoryItem> {
    const response = await this.request("/vortex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const created = (await response.json()) as Partial<InventoryItem>;
    if (typeof created.appid !== "number") {
      throw new Error(
        "Tornado server's create-application response did not include a numeric appid — cannot " +
          "create a local folder for it without one. The response shape assumption may be wrong.",
      );
    }
    return created as InventoryItem;
  }

  async fetchApplicationDesign(appid: number): Promise<ApplicationDesign> {
    const response = await this.request(`/vortex/${appid}/`);
    const body = (await response.json()) as ApplicationDesign;
    if (!Array.isArray(body.designelements)) {
      const keys = body && typeof body === "object" ? Object.keys(body).join(", ") : typeof body;
      logError(this.output, `  Unexpected response shape — top-level keys: ${keys}`);
      throw new Error(
        `Expected a "designelements" array in the response for app ${appid}, but got: ${keys}. ` +
          "The response shape assumption may be wrong — check the Tornado output channel for the raw response.",
      );
    }
    this.output?.appendLine(`  ${body.designelements.length} design element(s) for app ${appid}`);

    // Unlike designelements, a missing keyword array is not an error — an app
    // can simply have none, and this response's main job is the design. It is
    // logged, though: the alternative to a silent empty list is a keyword
    // editor that looks empty because the array arrived under a name nothing
    // recognises.
    const keywords = extractKeywords(body);
    if (keywords) {
      this.output?.appendLine(`  ${keywords.length} keyword(s) for app ${appid}`);
      // A keyword whose rows arrived under some other name would otherwise
      // show up in the editor as simply having no values — and saving it
      // would then write that emptiness back. Name the keys that did arrive.
      for (const keyword of keywords) {
        if (!Array.isArray(keyword.keyworddata)) {
          this.output?.appendLine(
            `  keyword "${keyword.name}" has no "keyworddata" array — keys present: ` +
              `${Object.keys(keyword).join(", ")}. Its values will show as empty; do not save it.`,
          );
        }
      }
    } else {
      this.output?.appendLine(
        `  no keyword array in the response for app ${appid} — top-level keys: ${Object.keys(body).join(", ")}`,
      );
    }

    // Same reasoning as keywords: no dataconnections array at all just means
    // this app has none, not an error.
    const dataconnections = extractDataConnections(body);
    if (dataconnections) {
      this.output?.appendLine(`  ${dataconnections.length} data connection(s) for app ${appid}`);
    } else {
      this.output?.appendLine(
        `  no dataconnections array in the response for app ${appid} — top-level keys: ${Object.keys(body).join(", ")}`,
      );
    }

    return { ...body, keywords: keywords ?? [], dataconnections: dataconnections ?? [] };
  }

  // An application's APPPARAM key/value pairs, as their own collection
  // alongside /vortex/{appid}/design — nothing else about the application is
  // read or written through here, so editing a parameter can't disturb the
  // app's own properties or its design elements.
  async fetchApplicationParams(appid: number): Promise<AppParam[]> {
    return this.fetchParams<AppParam>(`/vortex/${appid}/appparams`, `app ${appid}`);
  }

  async updateApplicationParams(appid: number, params: AppParam[]): Promise<void> {
    await this.putParams(`/vortex/${appid}/appparams`, APP_PARAMS_KEY, params);
  }

  // A design element's own parameter collection, the design-element-level
  // counterpart of /vortex/{appid}/appparams. Which parameter names belong
  // to an element depends on its design type — see buildDesignParamFields()
  // in extension.ts, which mirrors the server's saveParams().
  async fetchDesignParams(appid: number, designbucketid: number): Promise<DesignParam[]> {
    return this.fetchParams<DesignParam>(
      `/vortex/${appid}/design/${designbucketid}/params`,
      `design element ${designbucketid}`,
    );
  }

  async updateDesignParams(
    appid: number,
    designbucketid: number,
    params: DesignParam[],
  ): Promise<void> {
    await this.putParams(
      `/vortex/${appid}/design/${designbucketid}/params`,
      DESIGN_PARAMS_KEY,
      params,
    );
  }

  private async fetchParams<T extends AppParam | DesignParam>(
    path: string,
    subject: string,
  ): Promise<T[]> {
    const response = await this.request(path);
    const body = (await response.json()) as unknown;
    const params = extractParams<T>(body);
    if (!params) {
      const keys = body && typeof body === "object" ? Object.keys(body).join(", ") : typeof body;
      logError(this.output, `  Unexpected response shape — got: ${keys}`);
      throw new Error(
        `Expected an array of {paramname, paramvalue} for ${subject}, but got: ${keys}. ` +
          "Check the Tornado output channel for the raw response.",
      );
    }
    this.output?.appendLine(`  ${params.length} parameter(s) for ${subject}`);
    return params;
  }

  // Replaces the whole set — parameters the editor drops (a flag turned off,
  // a value cleared) are expressed by their absence from this array, so a
  // partial write would silently fail to remove anything.
  //
  // Wrapped in an object rather than sent as a bare top-level array: a bare
  // array is valid JSON and was verified to go out on the wire correctly
  // (right Content-Type, right Content-Length), but the server read no data
  // from it — a JSON parser expecting an object gets nothing from "[...]".
  // Every other write in this API is an object, and the design endpoint's
  // own responses wrap their list the same way ({"designelements": [...]}),
  // so this matches the house style rather than working around it.
  private async putParams(
    path: string,
    key: string,
    params: (AppParam | DesignParam)[],
  ): Promise<void> {
    await this.request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: params }),
    });
  }

  // An application's keywords (KEYWORD), each carrying its own value list
  // (KEYWORDDATA) inline. There is no keyword *read* endpoint: they come down
  // in the same app pull as the design elements, so this reuses that. Writes
  // do have their own endpoints (below) — a rename and its row edits save
  // together in one PUT rather than as two calls that can half-fail.
  //
  // Worth knowing: that app pull carries every design element's base64
  // content, so this is a heavy request for a small amount of data. If
  // reopening or saving in the keyword editor ever feels slow on a large
  // application, a lightweight GET /vortex/{appid}/keywords is the fix.
  async fetchKeywords(appid: number): Promise<Keyword[]> {
    const design = await this.fetchApplicationDesign(appid);
    return design.keywords;
  }

  // Fails loudly if the response omits the new keywordid, rather than leaving
  // the editor holding a keyword it can't address on the next save — same
  // guard as createDesignElement below.
  async createKeyword(appid: number, payload: NewKeywordPayload): Promise<Keyword> {
    const response = await this.request(`/vortex/${appid}/keywords`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [KEYWORD_KEY]: payload }),
    });
    // Read as text first so a failure can show what actually came back — a
    // 200 with the wrong shape is otherwise invisible, since only non-2xx
    // responses get their body logged.
    const raw = await response.text();
    let created: unknown;
    try {
      created = JSON.parse(raw);
    } catch {
      throw new Error(
        `Tornado server's create-keyword response was not JSON. It replied ${response.status} with: ` +
          `${raw.slice(0, 300) || "(an empty body)"}`,
      );
    }
    const keyword = unwrapKeyword(created);
    // A numeric string is accepted as well as a number: an id serialised from
    // a Java long often arrives quoted, and rejecting "412" while accepting
    // 412 would be a distinction without a difference here.
    const keywordid = keyword === undefined ? undefined : Number(keyword.keywordid);
    if (!keyword || keywordid === undefined || !Number.isFinite(keywordid)) {
      throw new Error(
        "Tornado server's create-keyword response did not include a numeric keywordid — cannot " +
          `address this keyword for later edits. It replied ${response.status} with: ${raw.slice(0, 300)}`,
      );
    }
    return { ...keyword, keywordid };
  }

  // The whole keyword, including every keyworddata row: the array replaces
  // what's stored, so a deleted row is expressed by its absence.
  async updateKeyword(appid: number, keywordid: number, keyword: Keyword): Promise<void> {
    await this.request(`/vortex/${appid}/keywords/${keywordid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [KEYWORD_KEY]: keyword }),
    });
  }

  async deleteKeyword(appid: number, keywordid: number): Promise<void> {
    await this.request(`/vortex/${appid}/keywords/${keywordid}`, { method: "DELETE" });
  }

  // Response shape (full created element, incl. new designbucketid) is
  // assumed, not confirmed against a real request — see the comment on
  // NewDesignElementPayload. Fails loudly if that assumption is wrong.
  async createDesignElement(
    appid: number,
    payload: NewDesignElementPayload,
  ): Promise<DesignElement> {
    const response = await this.request(`/vortex/${appid}/design`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const created = (await response.json()) as Partial<DesignElement>;
    if (typeof created.designbucketid !== "number") {
      throw new Error(
        "Tornado server's create-design response did not include a numeric designbucketid — " +
          "cannot track this new element locally. The response shape assumption may be wrong.",
      );
    }
    return created as DesignElement;
  }

  async updateDesignElement(
    appid: number,
    designbucketid: number,
    payload: DesignElementPayload,
  ): Promise<void> {
    await this.request(`/vortex/${appid}/design/${designbucketid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async deleteDesignElement(appid: number, designbucketid: number): Promise<void> {
    await this.request(`/vortex/${appid}/design/${designbucketid}`, { method: "DELETE" });
  }

  // The server's own puakma.jar — used as the compile classpath so Java
  // design elements are built against exactly the classes the server runs,
  // rather than a jar bundled with the extension that could drift out of
  // sync with the server's actual version.
  async downloadSystemJar(): Promise<ArrayBuffer> {
    const response = await this.request("/vortex/systemjar");
    const bytes = await response.arrayBuffer();
    this.output?.appendLine(`  ${bytes.byteLength} byte(s) received`);
    return bytes;
  }

  // A zip of the server's other shared library jars (also needed on the
  // compile classpath) — a zip *of jars*, not a jar-shaped zip, so it has to
  // be unpacked before its contents are usable as classpath entries.
  async downloadLibraries(): Promise<ArrayBuffer> {
    const response = await this.request("/vortex/libraries");
    const bytes = await response.arrayBuffer();
    this.output?.appendLine(`  ${bytes.byteLength} byte(s) received`);
    return bytes;
  }
}
