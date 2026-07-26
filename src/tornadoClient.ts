import * as vscode from "vscode";

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
    this.output?.appendLine(`→ ${method} ${url}`);

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
      this.output?.appendLine(`✘ ${method} ${url} — network error: ${message}`);
      throw new Error(`Could not reach ${url}: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.output?.appendLine(
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
      this.output?.appendLine(`  Unexpected response shape — top-level keys: ${keys}`);
      throw new Error(
        `Expected a "designelements" array in the response for app ${appid}, but got: ${keys}. ` +
          "The response shape assumption may be wrong — check the Tornado output channel for the raw response.",
      );
    }
    this.output?.appendLine(`  ${body.designelements.length} design element(s) for app ${appid}`);
    return body;
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
