// The mail server, which Calendar shares with Mail. Stalwart stores the calendars and contacts and serves them to
// calendar apps over CalDAV and CardDAV; Calendar talks to it over JMAP: its management methods (x:Domain, x:Account,
// x:Role, x:AppPassword, Stalwart 0.16 and later) with a service account, and the standard calendar and contacts
// methods (RFC 8620, JMAP for Calendars and Contacts) as a person, by impersonation (`<address>%<service account>`),
// so people never give Calendar their password. CalDAV is used only to export a calendar as one ICS file.

export const CORE = "urn:ietf:params:jmap:core";
export const MANAGEMENT = "urn:stalwart:jmap";
export const CALENDARS = "urn:ietf:params:jmap:calendars";
export const CONTACTS = "urn:ietf:params:jmap:contacts";
export const PRINCIPALS = "urn:ietf:params:jmap:principals";
export const AVAILABILITY = "urn:ietf:params:jmap:principals:availability";

export type Invocation = [name: string, args: Record<string, any>, id: string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
}

export interface JmapResponse {
  methodResponses: Invocation[];
  sessionState?: string;
}

export interface JmapSession {
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly?: boolean; accountCapabilities: Record<string, unknown> }>;
  capabilities: Record<string, unknown>;
  state: string;
}

export interface StalwartDomain {
  id: string;
  name: string;
}

/** A Stalwart account; only the properties Calendar sets or reads. */
export interface StalwartAccount {
  id: string;
  /** User for a mailbox or a room, Group for a team. */
  "@type": string;
  name: string;
  domainId: string;
  emailAddress?: string;
  description?: string | null;
  /** Calendar marks the accounts it made: openasy-calendar:room or openasy-calendar:team. */
  externalId?: string | null;
  aliases?: Record<string, { name: string; domainId: string }> | null;
  memberGroupIds?: Record<string, boolean> | null;
  permissions?: { "@type": string; disabledPermissions?: Record<string, boolean> } | null;
  /** User for a mailbox, Admin for administrators and service accounts, Custom for Calendar's rooms. */
  roles?: { "@type": string; roleIds?: Record<string, boolean> } | null;
}

export interface StalwartRole {
  id: string;
  description: string;
  enabledPermissions?: Record<string, boolean>;
}

export interface AppPassword {
  id: string;
  description: string;
  createdAt?: string;
}

export class StalwartError extends Error {
  /** The HTTP status Stalwart answered with, or 0 when it could not be reached. */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export interface StalwartOptions {
  /** Where Calendar reaches Stalwart's HTTP listener, such as http://stalwart:8080. */
  url: string;
  /** The service account Calendar manages and impersonates with; it needs the impersonate permission. */
  user: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** Throws when a /set left anything not created, updated or destroyed, naming each and why. */
export function checkSet(name: string, r: Record<string, unknown>) {
  const failed = ["notCreated", "notUpdated", "notDestroyed"].flatMap((k) =>
    Object.entries((r[k] as Record<string, { type?: string; description?: string }> | null) ?? {}).map(
      ([id, e]) => `${id}: ${e.description ?? e.type ?? "refused"}`,
    ),
  );
  if (failed.length) throw new StalwartError(`${name}: ${failed.join("; ")}`, 200);
}

export function createStalwart({ url, user, password, fetch: f = fetch, timeoutMs = 15_000 }: StalwartOptions) {
  const base = url.replace(/\/$/, "");
  const admin = basic(user, password);
  /** The header that acts as one person or room; Stalwart checks the service account's password and permission. */
  const as = (addr: string) => basic(`${addr}%${user}`, password);

  async function request(path: string, init: RequestInit & { authorization: string }, ok = (r: Response) => r.ok): Promise<Response> {
    let res: Response;
    try {
      res = await f(path.startsWith("http") ? path : base + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: init.authorization },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StalwartError(`The mail server at ${base} cannot be reached: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new StalwartError("The mail server refused the service account; check CALENDAR_STALWART_USER and its password.", 401);
    if (!ok(res)) throw new StalwartError(`The mail server answered ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    return res;
  }

  async function jmap(authorization: string, body: JmapRequest, apiUrl = "/jmap/"): Promise<JmapResponse> {
    const res = await request(apiUrl, { method: "POST", authorization, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as JmapResponse;
  }

  /** One method as the service account; throws with Stalwart's own description when it answers with an error. */
  async function manage<T>(name: string, args: Record<string, unknown>, using = [CORE, MANAGEMENT]): Promise<T> {
    const r = await jmap(admin, { using, methodCalls: [[name, args, "0"]] });
    const [got, result] = r.methodResponses[0] ?? [];
    if (got === "error") throw new StalwartError(`${name}: ${String(result?.description ?? result?.type ?? "error")}`, 200);
    return result as T;
  }

  return {
    url: base,
    manage,

    async domains(): Promise<StalwartDomain[]> {
      return (await manage<{ list: StalwartDomain[] }>("x:Domain/get", { ids: null, properties: ["id", "name"] })).list;
    },
    async createDomain(name: string): Promise<string> {
      const r = await manage<{ created?: Record<string, { id: string }> }>("x:Domain/set", { create: { d: { name } } });
      checkSet("x:Domain/set", r);
      return r.created!.d!.id;
    },

    async accounts(): Promise<StalwartAccount[]> {
      return (await manage<{ list: StalwartAccount[] }>("x:Account/get", { ids: null })).list;
    },
    /** Creates and updates accounts in one call; returns the ids of the created ones by their key. */
    async setAccounts(changes: {
      create?: Record<string, Record<string, unknown>>;
      update?: Record<string, Record<string, unknown>>;
    }): Promise<Record<string, string>> {
      const r = await manage<Record<string, unknown>>("x:Account/set", changes);
      checkSet("x:Account/set", r);
      return Object.fromEntries(Object.entries((r.created as Record<string, { id: string }> | null) ?? {}).map(([k, v]) => [k, v.id]));
    },

    async roles(): Promise<StalwartRole[]> {
      return (await manage<{ list: StalwartRole[] }>("x:Role/get", { ids: null })).list;
    },
    async setRole(id: string | null, role: Omit<StalwartRole, "id">): Promise<string> {
      const r = await manage<{ created?: Record<string, { id: string }> }>("x:Role/set", id ? { update: { [id]: role } } : { create: { r: role } });
      checkSet("x:Role/set", r);
      return id ?? r.created!.r!.id;
    },

    async appPasswords(accountId: string): Promise<AppPassword[]> {
      return (await manage<{ list: AppPassword[] }>("x:AppPassword/get", { accountId, ids: null })).list;
    },
    /** A password for one device; Stalwart returns its secret only here. */
    async createAppPassword(accountId: string, description: string): Promise<{ id: string; secret: string }> {
      const r = await manage<{ created?: Record<string, { id: string; secret: string }> }>("x:AppPassword/set", {
        accountId,
        create: { p: { description, permissions: { "@type": "Inherit" }, allowedIps: {} } },
      });
      checkSet("x:AppPassword/set", r);
      return r.created!.p!;
    },
    async deleteAppPassword(accountId: string, id: string): Promise<void> {
      checkSet("x:AppPassword/set", await manage<Record<string, unknown>>("x:AppPassword/set", { accountId, destroy: [id] }));
    },

    /** The JMAP session of one person or room, by impersonation. */
    async session(addr: string): Promise<JmapSession> {
      return (await (await request("/.well-known/jmap", { authorization: as(addr) })).json()) as JmapSession;
    },
    /** Standard JMAP calls as one person or room, to their session's apiUrl. */
    async call(addr: string, body: JmapRequest, apiUrl = "/jmap/"): Promise<JmapResponse> {
      return jmap(as(addr), body, apiUrl);
    },
    /**
     * Standard JMAP calls as the service account, which may read any account: a team's, whose account cannot sign in,
     * and that of someone who left, whose meetings are handed over.
     */
    async callAsService(body: JmapRequest): Promise<JmapResponse> {
      return jmap(admin, body);
    },
    async upload(addr: string, url: string, type: string, body: Buffer): Promise<{ blobId: string; type: string; size: number }> {
      return (await request(url, { method: "POST", authorization: as(addr), headers: { "content-type": type }, body })).json() as Promise<{
        blobId: string;
        type: string;
        size: number;
      }>;
    },
    /** A CalDAV or CardDAV request as one person; 207 Multi-Status is the answer to PROPFIND and REPORT. */
    async dav(addr: string, method: string, path: string, body: string, depth = "1"): Promise<string> {
      const res = await request(
        path,
        { method, authorization: as(addr), headers: { depth, "content-type": "application/xml; charset=utf-8" }, body },
        (r) => r.ok || r.status === 207,
      );
      return res.text();
    },
    async ping(): Promise<void> {
      await manage("Core/echo", {});
    },
  };
}

export type Stalwart = ReturnType<typeof createStalwart>;
