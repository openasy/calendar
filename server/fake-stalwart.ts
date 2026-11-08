// A mail server in memory for tests, answering the JMAP, CalDAV and CardDAV calls Calendar makes the way Stalwart 0.16
// does. Given to createStalwart() as its fetch, so the real client code runs against it.
import type { Invocation, StalwartAccount, StalwartRole } from "./stalwart.ts";

export const SERVICE_USER = "openasy-calendar";
export const SERVICE_PASSWORD = "service-password";
const PUBLIC = "https://mail.example.com";

interface FakeEvent {
  id: string;
  uid: string;
  calendarIds: Record<string, boolean>;
  title?: string;
  utcStart?: string;
  utcEnd?: string;
  participants?: Record<string, { calendarAddress?: string; participationStatus?: string }>;
  [k: string]: unknown;
}

export function fakeStalwart() {
  let next = 0;
  const id = () => (next++).toString(36);
  const domains = new Map<string, { id: string; name: string }>();
  const accounts = new Map<string, StalwartAccount>();
  const roles = new Map<string, StalwartRole>([
    ["r-user", { id: "r-user", description: "User" }],
    ["r-admin", { id: "r-admin", description: "System Administrator" }],
  ]);
  const appPasswords = new Map<string, Array<{ id: string; description: string }>>();
  /** Calendars and events by account. */
  const calendars = new Map<string, Array<{ id: string; name: string; isDefault: boolean; shareWith: Record<string, unknown> }>>();
  const events = new Map<string, FakeEvent[]>();
  const blobs = new Map<string, { type: string; data: Buffer }>();
  /** Every JMAP call, with who made it: the service account or the person it acted as. */
  const calls: Array<{ as: string; method: string; args: Record<string, any> }> = [];
  const state = { down: false, ics: "" };

  const addressOf = (a: StalwartAccount) => `${a.name}@${[...domains.values()].find((d) => d.id === a.domainId)?.name}`;
  const accountByAddress = (addr: string) => [...accounts.values()].find((a) => addressOf(a) === addr);
  const calendarsOf = (accountId: string) => {
    if (!calendars.has(accountId))
      calendars.set(accountId, [{ id: "b", name: `Stalwart Calendar (${addressOf(accounts.get(accountId)!)})`, isDefault: true, shareWith: {} }]);
    return calendars.get(accountId)!;
  };
  const disabled = (a: StalwartAccount) => a.permissions?.["@type"] === "Merge";

  /** Who the Authorization header is: null when the password or the form is wrong. */
  function who(header: string | null): { as: string } | null | "forbidden" {
    if (!header?.startsWith("Basic ")) return null;
    const [user, password] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (password !== SERVICE_PASSWORD) return null;
    if (user === SERVICE_USER) return { as: SERVICE_USER };
    const [target, by] = user!.split("%");
    if (by !== SERVICE_USER) return null;
    const account = accountByAddress(target!);
    // As Stalwart: a group cannot be acted as, nor an account that may not sign in.
    if (!account || account["@type"] !== "User" || disabled(account)) return "forbidden";
    return { as: target! };
  }

  function set(store: Map<string, any>, args: Record<string, any>, make: (v: any) => any) {
    const created: Record<string, unknown> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(args.create ?? {})) {
      const obj = make(v);
      store.set(obj.id, obj);
      created[key] = obj.secret ? { id: obj.id, secret: obj.secret } : { id: obj.id };
    }
    for (const [key, patch] of Object.entries(args.update ?? {})) {
      const obj = store.get(key);
      if (!obj) notUpdated[key] = { type: "notFound" };
      else (Object.assign(obj, patch), (updated[key] = null));
    }
    for (const key of (args.destroy ?? []) as string[]) store.delete(key);
    return { created, updated, notUpdated, destroyed: args.destroy ?? [] };
  }

  /** The accounts a person reaches: their own and their groups'. */
  function reach(as: string): string[] {
    if (as === SERVICE_USER) return [...accounts.keys()];
    const me = accountByAddress(as);
    if (!me) return [];
    return [me.id, ...Object.keys(me.memberGroupIds ?? {})];
  }

  function method(as: string, [name, args, callId]: Invocation): Invocation {
    calls.push({ as, method: name, args });
    if (as !== SERVICE_USER && name.startsWith("x:")) return ["error", { type: "forbidden" }, callId];
    if (args.accountId && !name.startsWith("x:") && !reach(as).includes(args.accountId))
      return ["error", { type: "forbidden", description: `You do not have access to account ${args.accountId}` }, callId];
    switch (name) {
      case "Core/echo":
        return [name, args, callId];
      case "x:Domain/get":
        return [name, { list: [...domains.values()] }, callId];
      case "x:Domain/set":
        return [name, set(domains, args, (v) => ({ id: id(), name: v.name })), callId];
      case "x:Account/get":
        return [name, { list: [...accounts.values()].map((a) => ({ ...structuredClone(a), emailAddress: addressOf(a) })) }, callId];
      case "x:Account/set":
        return [name, set(accounts, args, (v) => ({ ...v, id: id() })), callId];
      case "x:Role/get":
        return [name, { list: [...roles.values()].map((r) => structuredClone(r)) }, callId];
      case "x:Role/set":
        return [name, set(roles, args, (v) => ({ ...v, id: id() })), callId];
      case "x:AppPassword/get":
        return [name, { list: appPasswords.get(args.accountId as string) ?? [] }, callId];
      case "x:AppPassword/set": {
        const list = appPasswords.get(args.accountId as string) ?? [];
        const store = new Map(list.map((p) => [p.id, p]));
        const r = set(store, args, (v) => ({ id: id(), description: v.description, secret: `secret-${next}` }));
        appPasswords.set(
          args.accountId as string,
          [...store.values()].map((p) => ({ id: p.id, description: p.description })),
        );
        return [name, r, callId];
      }
      case "Calendar/get":
        return [
          name,
          {
            accountId: args.accountId,
            state: "s1",
            list: calendarsOf(args.accountId)
              .map((c) => ({
                ...c,
                color: null,
                isVisible: true,
                myRights: {
                  mayReadFreeBusy: true,
                  mayReadItems: true,
                  mayWriteAll: true,
                  mayWriteOwn: true,
                  mayUpdatePrivate: true,
                  mayRSVP: true,
                  mayShare: true,
                  mayDelete: true,
                },
              }))
              .filter((c) => !args.ids || args.ids.includes(c.id)),
          },
          callId,
        ];
      case "Calendar/set": {
        const list = calendarsOf(args.accountId);
        const updated: Record<string, null> = {};
        for (const [cid, patch] of Object.entries((args.update ?? {}) as Record<string, object>)) {
          const c = list.find((x) => x.id === cid);
          if (c) (Object.assign(c, patch), (updated[cid] = null));
        }
        return [name, { accountId: args.accountId, updated }, callId];
      }
      case "AddressBook/get":
        return [
          name,
          {
            accountId: args.accountId,
            list: [
              { id: "b", name: "Stalwart Address Book", isDefault: true, myRights: { mayRead: true, mayWrite: true, mayDelete: true, mayShare: true } },
            ].filter((c) => !args.ids || args.ids.includes(c.id)),
          },
          callId,
        ];
      case "AddressBook/set":
        return [name, { accountId: args.accountId, updated: Object.fromEntries(Object.keys(args.update ?? {}).map((k) => [k, null])) }, callId];
      case "CalendarEvent/get": {
        const list = events.get(args.accountId) ?? [];
        return [name, { accountId: args.accountId, state: `s${list.length}`, list: list.filter((e) => !args.ids || args.ids.includes(e.id)) }, callId];
      }
      case "CalendarEvent/query":
        return [name, { accountId: args.accountId, queryState: "s1", ids: (events.get(args.accountId) ?? []).map((e) => e.id) }, callId];
      case "CalendarEvent/changes":
        return [
          name,
          {
            accountId: args.accountId,
            oldState: args.sinceState,
            newState: `s${(events.get(args.accountId) ?? []).length}`,
            created: [],
            updated: [],
            destroyed: [],
          },
          callId,
        ];
      case "CalendarEvent/set": {
        const list = events.get(args.accountId) ?? [];
        events.set(args.accountId, list);
        const created: Record<string, { id: string }> = {};
        for (const [k, v] of Object.entries((args.create ?? {}) as Record<string, object>)) {
          const e = { uid: `uid-${next}`, ...v, id: id() } as FakeEvent;
          list.push(e);
          created[k] = { id: e.id };
        }
        const updated: Record<string, null> = {};
        for (const [k, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
          const e = list.find((x) => x.id === k);
          if (!e) continue;
          for (const [path, v] of Object.entries(patch)) {
            const keys = path.split("/");
            let at: Record<string, any> = e;
            for (const key of keys.slice(0, -1)) at = at[key] ??= {};
            at[keys.at(-1)!] = v;
          }
          updated[k] = null;
        }
        const destroyed = ((args.destroy ?? []) as string[]).filter((d) => list.some((e) => e.id === d));
        events.set(
          args.accountId,
          list.filter((e) => !destroyed.includes(e.id)),
        );
        return [name, { accountId: args.accountId, created, updated, destroyed }, callId];
      }
      case "Principal/getAvailability": {
        // As Stalwart: only the person's own times, and never what they are.
        const list = (events.get(args.accountId) ?? [])
          .filter((e) => e.utcStart && e.utcEnd && e.utcEnd > args.utcStart && e.utcStart < args.utcEnd)
          .map((e) => ({ utcStart: e.utcStart, utcEnd: e.utcEnd, busyStatus: "confirmed", event: null }));
        return [name, { list }, callId];
      }
      default:
        // Other calendar and contacts methods answer with what they were asked and who asked.
        return [name, { accountId: args.accountId ?? null, as }, callId];
    }
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const CALS = ["urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:contacts", "urn:ietf:params:jmap:principals"];

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (state.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const auth = who(new Headers(init.headers).get("authorization"));
    if (auth === "forbidden") return new Response("Forbidden", { status: 403 });
    if (!auth) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/.well-known/jmap") {
      const me = accountByAddress(auth.as);
      const accountId = me?.id ?? "";
      const reachable = reach(auth.as)
        .map((a) => accounts.get(a))
        .filter((a): a is StalwartAccount => !!a);
      return json({
        username: auth.as,
        apiUrl: `${PUBLIC}/jmap/`,
        downloadUrl: `${PUBLIC}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
        uploadUrl: `${PUBLIC}/jmap/upload/{accountId}/`,
        primaryAccounts: Object.fromEntries(CALS.map((c) => [c, accountId])),
        accounts: Object.fromEntries(
          reachable.map((a) => [
            a.id,
            { name: addressOf(a), isPersonal: a.id === accountId, accountCapabilities: Object.fromEntries(CALS.map((c) => [c, {}])) },
          ]),
        ),
        capabilities: { "urn:ietf:params:jmap:core": {}, ...Object.fromEntries(CALS.map((c) => [c, {}])), "urn:stalwart:jmap": {} },
        state: "s1",
      });
    }
    if (url.pathname === "/jmap/" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { methodCalls: Invocation[] };
      return json({ methodResponses: body.methodCalls.map((c) => method(auth.as, c)), sessionState: "s1" });
    }
    const up = /^\/jmap\/upload\/([^/]+)\/$/.exec(url.pathname);
    if (up && init.method === "POST") {
      const blobId = `b${id()}`;
      const data = Buffer.from(init.body as Buffer);
      blobs.set(blobId, { type: new Headers(init.headers).get("content-type") ?? "", data });
      return json({ accountId: decodeURIComponent(up[1]!), blobId, type: new Headers(init.headers).get("content-type") ?? "", size: data.length });
    }
    const dav = /^\/dav\/(cal|card)\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (dav) {
      const owner = decodeURIComponent(dav[2]!);
      const home = `/dav/${dav[1]}/${encodeURIComponent(owner)}/`;
      const kind = dav[1] === "cal" ? "<A:calendar/>" : "<B:addressbook/>";
      if (init.method === "PROPFIND") {
        const a = accountByAddress(owner);
        const names = a ? (dav[1] === "cal" ? calendarsOf(a.id).map((c) => c.name) : ["Stalwart Address Book"]) : [];
        const responses = [
          `<D:response><D:href>${home}</D:href><D:propstat><D:prop><D:displayname>${owner}</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`,
          ...names.map(
            (n, i) =>
              `<D:response><D:href>${home}${i === 0 ? "default" : `c${i}`}/</D:href><D:propstat><D:prop><D:displayname>${n.replace(/&/g, "&amp;")}</D:displayname><D:resourcetype><D:collection/>${kind}</D:resourcetype></D:prop></D:propstat></D:response>`,
          ),
        ];
        return new Response(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav" xmlns:B="urn:ietf:params:xml:ns:carddav">${responses.join("")}</D:multistatus>`,
          { status: 207 },
        );
      }
      if (init.method === "REPORT") {
        const element = dav[1] === "cal" ? "A:calendar-data" : "B:address-data";
        const data = dav[1] === "cal" ? state.ics : "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Dana Brooks\r\nEND:VCARD\r\n";
        return new Response(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav" xmlns:B="urn:ietf:params:xml:ns:carddav"><D:response><D:href>${home}x</D:href><D:propstat><D:prop><${element}><![CDATA[${data}]]></${element}></D:prop></D:propstat></D:response></D:multistatus>`,
          { status: 207 },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;

  /** A mailbox as Mail makes it. */
  function mailbox(address: string, name: string) {
    const [local, domain] = address.split("@") as [string, string];
    let d = [...domains.values()].find((x) => x.name === domain);
    if (!d) ((d = { id: id(), name: domain }), domains.set(d.id, d));
    const a: StalwartAccount = {
      id: id(),
      "@type": "User",
      name: local,
      domainId: d.id,
      description: name,
      roles: { "@type": "User" },
      permissions: { "@type": "Inherit" },
    };
    accounts.set(a.id, a);
    return a;
  }

  return { fetch, domains, accounts, roles, appPasswords, calendars, events, calls, state, addressOf, accountByAddress, mailbox };
}

export type FakeStalwart = ReturnType<typeof fakeStalwart>;
