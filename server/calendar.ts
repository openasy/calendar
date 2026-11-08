// What the routes call: the teams and rooms from the file, keeping the mail server in step with it, and a person's own
// calendars and contacts, their colleagues' free and busy times, the rooms' bookings, device passwords, exports and
// subscription links, and the meetings of people who left. The calendars and contacts stay on the mail server;
// Calendar keeps none of them.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CalendarConfig, ConfigFileState } from "./config.ts";
import { ADDRESSBOOK_QUERY, CALENDAR_QUERY, collections, DISPLAY_NAMES, davData, joinCalendars, joinCards } from "./ics.ts";
import type { Directory } from "./identity.ts";
import { log } from "./log.ts";
import { answerRooms, type RoomState } from "./rooms.ts";
import {
  AVAILABILITY,
  CALENDARS,
  CONTACTS,
  CORE,
  PRINCIPALS,
  StalwartError,
  type AppPassword,
  type Invocation,
  type JmapRequest,
  type JmapResponse,
  type JmapSession,
  type Stalwart,
  type StalwartAccount,
} from "./stalwart.ts";
import { addressOf, isDisabled, isOurs, sync, type SyncResult } from "./sync.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "not-found"
  | "no-mailbox"
  | "method-not-allowed"
  | "mail-server-unavailable"
  | "payload-too-large"
  | "internal-error";

export class CalendarError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const PARSE_CALENDARS = "urn:ietf:params:jmap:calendars:parse";
const PARSE_CONTACTS = "urn:ietf:params:jmap:contacts:parse";
/** What the pages may use. Stalwart's management methods (x:*) and mail are never passed on. */
export const CAPABILITIES = [CORE, CALENDARS, PARSE_CALENDARS, CONTACTS, PARSE_CONTACTS, PRINCIPALS];
export const METHODS = new Set([
  "Core/echo",
  "Calendar/get",
  "Calendar/changes",
  "Calendar/set",
  "CalendarEvent/get",
  "CalendarEvent/changes",
  "CalendarEvent/query",
  "CalendarEvent/queryChanges",
  "CalendarEvent/set",
  "CalendarEvent/copy",
  "CalendarEvent/parse",
  "CalendarEventNotification/get",
  "CalendarEventNotification/changes",
  "CalendarEventNotification/query",
  "CalendarEventNotification/set",
  "ParticipantIdentity/get",
  "AddressBook/get",
  "AddressBook/changes",
  "AddressBook/set",
  "ContactCard/get",
  "ContactCard/changes",
  "ContactCard/query",
  "ContactCard/queryChanges",
  "ContactCard/set",
  "ContactCard/copy",
  "ContactCard/parse",
]);

/** One account a person's session reaches: their own, a team's, or a colleague's that was shared with them. */
export interface SessionAccount {
  id: string;
  /** The account's address. */
  address: string;
  /** The person's or team's name. */
  name: string;
  kind: "own" | "team" | "shared";
}

export interface CalendarSession {
  address: string;
  name: string | null;
  /** The person's own account, for calendars, contacts and their principal. */
  accountId: string;
  accounts: SessionAccount[];
  /** Where calendar apps connect, for the device set-up. */
  dav: { server: string; calendars: string; contacts: string };
  state: string;
}

export interface Person {
  address: string;
  name: string;
  /** The person's account on the mail server, which is also their principal, for sharing. */
  principalId: string;
  /** Their groups in Identity, when the directory comes from there. */
  groups: string[];
}

export interface CalendarOptions {
  /** The address calendar apps reach Stalwart at, such as https://mail.example.com (CALENDAR_DAV_URL). */
  davUrl: string;
  /** The address people open Calendar at, for subscription links. */
  publicUrl: string;
  /** People's names and groups from Identity, when it is set up (CALENDAR_IDENTITY_URL). */
  directory?: Directory;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
}

/** The path of a URL Stalwart gave, so Calendar calls it at the address it reaches the server at, not its public name. */
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/i, "");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const USING = [CORE, CALENDARS, CONTACTS, PRINCIPALS, AVAILABILITY];
const DAY = 86_400_000;

export function createCalendar(
  db: DatabaseSync,
  stalwart: Stalwart,
  { davUrl, publicUrl, directory, clock = Date.now, fileState = () => null }: CalendarOptions,
) {
  let config: CalendarConfig = { teams: [], rooms: [] };
  let last: SyncResult | null = null;
  let running: Promise<SyncResult> | null = null;
  let again = false;
  let roomsRunning: Promise<unknown> | null = null;
  const roomState: RoomState = new Map();
  const sessions = new Map<string, { session: JmapSession; until: number }>();
  let accountCache: { accounts: StalwartAccount[]; names: Map<string, string>; until: number } | null = null;
  const dav = davUrl.replace(/\/$/, "");

  const insert = db.prepare("INSERT INTO sync_runs (at, ok, created, updated, disabled, warnings, error) VALUES (?, ?, ?, ?, ?, ?, ?)");

  /** Brings the server in step with the file; a call while one runs makes it run once more after. */
  function syncNow(): Promise<SyncResult> {
    if (running) {
      again = true;
      return running;
    }
    running = sync(stalwart, config, () => new Date(clock()))
      .then((r) => {
        last = r;
        accountCache = null;
        sessions.clear();
        insert.run(r.at, r.ok ? 1 : 0, r.created.length, r.updated.length, r.disabled.length, r.warnings.length, r.error);
        db.prepare("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 100)").run();
        if (r.ok && (r.created.length || r.updated.length || r.disabled.length))
          log("info", "mail server updated from the file", { created: r.created, updated: r.updated, disabled: r.disabled });
        else if (!r.ok) log("warn", "mail server not updated; trying again in five minutes", { error: r.error });
        if (r.warnings.length) log("warn", "the calendar file names what the mail server does not have", { warnings: r.warnings });
        return r;
      })
      .finally(() => {
        running = null;
        if (again) ((again = false), void syncNow());
      });
    return running;
  }

  /** Stalwart's failures as a problem the pages can show; other errors go up as they are. */
  async function server<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StalwartError) {
        log("warn", "mail server call failed", { error: err.message, status: err.status });
        throw new CalendarError(502, "mail-server-unavailable", "The mail server did not answer; try again in a moment.");
      }
      throw err;
    }
  }

  /** The server's accounts, read again at most once a minute. */
  async function accounts() {
    if (accountCache && accountCache.until > clock()) return accountCache;
    const [list, domains] = await server(() => Promise.all([stalwart.accounts(), stalwart.domains()]));
    accountCache = { accounts: list, names: new Map(domains.map((d) => [d.id, d.name.toLowerCase()])), until: clock() + 60_000 };
    return accountCache;
  }

  /** The mailboxes of people: accounts of type User with the User role, not disabled, and not a room. */
  async function people(): Promise<Array<{ address: string; account: StalwartAccount }>> {
    const { accounts: list, names } = await accounts();
    return list
      .filter((a) => a["@type"] === "User" && !isOurs(a) && !isDisabled(a) && (a.roles?.["@type"] ?? "User") === "User")
      .map((a) => ({ address: addressOf(a, names), account: a }));
  }

  /** The signed-in person's mailbox: their address must be a person's account on the mail server that is not disabled. */
  async function own(addr: string): Promise<{ address: string; account: StalwartAccount }> {
    const a = addr.trim().toLowerCase();
    let me = (await people()).find((p) => p.address === a);
    if (!me) {
      // A mailbox Mail made a moment ago.
      accountCache = null;
      me = (await people()).find((p) => p.address === a);
    }
    if (!me) throw new CalendarError(403, "no-mailbox", `${a} has no mailbox on the mail server; Mail's domains file gives people one.`);
    return me;
  }

  async function sessionOf(addr: string): Promise<JmapSession> {
    const hit = sessions.get(addr);
    if (hit && hit.until > clock()) return hit.session;
    const session = await server(() => stalwart.session(addr));
    sessions.set(addr, { session, until: clock() + 5 * 60_000 });
    return session;
  }

  /** Calls as one person or room, failing on any method error with its description. */
  async function as(addr: string, methodCalls: Invocation[]): Promise<Invocation[]> {
    const r = await server(() => stalwart.call(addr, { using: USING, methodCalls }));
    const failed = r.methodResponses.find(([n]) => n === "error");
    if (failed)
      throw new CalendarError(
        502,
        "mail-server-unavailable",
        `The mail server refused ${String(failed[2])}: ${String(failed[1].description ?? failed[1].type)}`,
      );
    return r.methodResponses;
  }

  async function asService(methodCalls: Invocation[]): Promise<Invocation[]> {
    const r = await server(() => stalwart.callAsService({ using: USING, methodCalls }));
    const failed = r.methodResponses.find(([n]) => n === "error");
    if (failed)
      throw new CalendarError(
        502,
        "mail-server-unavailable",
        `The mail server refused ${String(failed[2])}: ${String(failed[1].description ?? failed[1].type)}`,
      );
    return r.methodResponses;
  }

  /** The names people go by: from Identity when it is set up, else as the mail server has them. */
  async function directoryNames(): Promise<Map<string, { name: string; groups: string[] }>> {
    const out = new Map<string, { name: string; groups: string[] }>();
    if (!directory) return out;
    try {
      for (const p of await directory.people()) out.set(p.email.toLowerCase(), { name: p.name, groups: p.groups });
    } catch (err) {
      log("warn", "Identity's directory could not be read; names come from the mail server", { error: (err as Error).message });
    }
    return out;
  }

  /** The DAV collection of a calendar or address book, found by its name in the owner's collections. */
  async function collectionOf(addr: string, kind: "cal" | "card", owner: string, name: string, isDefault: boolean): Promise<string> {
    const home = `/dav/${kind}/${encodeURIComponent(owner)}/`;
    const found = collections(await server(() => stalwart.dav(addr, "PROPFIND", home, DISPLAY_NAMES))).filter(
      (c) => c.href.startsWith(home) && c.href !== home,
    );
    const named = found.filter((c) => c.name === name);
    const pick =
      named.length === 1
        ? named[0]
        : (named.find((c) => isDefault && c.href.endsWith("/default/")) ?? (isDefault ? found.find((c) => c.href.endsWith("/default/")) : undefined));
    if (!pick)
      throw new CalendarError(
        404,
        "not-found",
        named.length > 1 ? `More than one collection is called ${name}; give each its own name.` : `${name} was not found on the mail server.`,
      );
    return pick.href;
  }

  /** The account of a session by id, with its address. */
  async function accountIn(addr: string, accountId: string): Promise<SessionAccount> {
    const s = await sessionOf(addr);
    const a = s.accounts[accountId];
    if (!a) throw new CalendarError(404, "not-found", "No such calendar account.");
    return { id: accountId, address: a.name.toLowerCase(), name: a.name, kind: a.isPersonal ? "own" : "shared" };
  }

  async function calendarIcs(owner: string, accountId: string, calendarId: string, busy?: string): Promise<{ name: string; ics: string }> {
    const account = await accountIn(owner, accountId);
    const [[, got]] = (await as(owner, [["Calendar/get", { accountId, ids: [calendarId], properties: ["name", "isDefault"] }, "0"]])) as [Invocation];
    const cal = (got.list as Array<{ name: string; isDefault?: boolean }>)[0];
    if (!cal) throw new CalendarError(404, "not-found", "No such calendar.");
    const href = await collectionOf(owner, "cal", account.address, cal.name, cal.isDefault === true);
    const docs = davData(await server(() => stalwart.dav(owner, "REPORT", href, CALENDAR_QUERY)), "calendar-data");
    return { name: cal.name, ics: joinCalendars(docs, { name: cal.name, busy }) };
  }

  return {
    /** Takes the file and starts bringing the server in step; the promise is that sync. */
    setConfig(next: CalendarConfig): Promise<SyncResult> {
      config = next;
      for (const r of roomState.keys()) if (!next.rooms.some((x) => x.address === r)) roomState.delete(r);
      return syncNow();
    },
    config: () => config,
    syncNow,
    lastSync: () => last,

    /** Answers the rooms' open invitations; a round still running is not started again. */
    answerRooms(): Promise<unknown> {
      if (roomsRunning) return roomsRunning;
      roomsRunning = answerRooms(stalwart, config.rooms, roomState, db, clock).finally(() => (roomsRunning = null));
      return roomsRunning;
    },

    summary() {
      return { teams: config.teams.length, rooms: config.rooms.length, file: fileState(), sync: last, davUrl: dav };
    },

    /** The signed-in person's session: their own account, their teams' and what colleagues shared with them. */
    async session(addr: string): Promise<CalendarSession> {
      const me = await own(addr);
      const s = await sessionOf(me.address);
      const accountId = s.primaryAccounts[CALENDARS];
      if (!accountId) throw new CalendarError(502, "mail-server-unavailable", "The mail server has no calendar for this person yet; it is being set up.");
      const teams = new Map(config.teams.map((t) => [t.address, t.name]));
      const names = await directoryNames();
      const everyone = new Map((await people()).map((p) => [p.address, p.account.description ?? null]));
      const list: SessionAccount[] = Object.entries(s.accounts)
        .filter(([, a]) => CALENDARS in a.accountCapabilities || CONTACTS in a.accountCapabilities)
        .map(([id, a]) => {
          const address = a.name.toLowerCase();
          const kind = a.isPersonal ? "own" : teams.has(address) ? "team" : "shared";
          const name = teams.get(address) ?? names.get(address)?.name ?? everyone.get(address) ?? address;
          return { id, address, name, kind } as SessionAccount;
        })
        .sort((a, b) => ["own", "team", "shared"].indexOf(a.kind) - ["own", "team", "shared"].indexOf(b.kind) || a.name.localeCompare(b.name));
      return {
        address: me.address,
        name: names.get(me.address)?.name ?? me.account.description ?? null,
        accountId,
        accounts: list,
        dav: { server: dav, calendars: `${dav}/dav/cal/${me.address}/`, contacts: `${dav}/dav/card/${me.address}/` },
        state: s.state,
      };
    },

    /** JMAP calls from the pages, as the signed-in person, limited to their calendars and contacts. */
    async call(addr: string, body: unknown): Promise<JmapResponse> {
      const me = await own(addr);
      const req = body as JmapRequest;
      if (
        !req ||
        typeof req !== "object" ||
        !Array.isArray(req.using) ||
        !Array.isArray(req.methodCalls) ||
        req.methodCalls.length > 16 ||
        req.methodCalls.some(
          (c) => !Array.isArray(c) || c.length !== 3 || typeof c[0] !== "string" || typeof c[2] !== "string" || !c[1] || typeof c[1] !== "object",
        )
      )
        throw new CalendarError(400, "invalid-body", "A JMAP request: using, and up to 16 methodCalls of [name, arguments, id].");
      const blocked = req.methodCalls.map((c) => c[0]).filter((n) => !METHODS.has(n));
      if (blocked.length) throw new CalendarError(403, "method-not-allowed", `Not available to the pages: ${[...new Set(blocked)].join(", ")}.`);
      const using = req.using.filter((u) => typeof u === "string" && CAPABILITIES.includes(u));
      const s = await sessionOf(me.address);
      return server(() => stalwart.call(me.address, { using, methodCalls: req.methodCalls }, pathOf(s.apiUrl)));
    },

    /** A file to import, such as an .ics or .vcf, put on the mail server for CalendarEvent/parse or ContactCard/parse. */
    async upload(addr: string, type: string, data: Buffer) {
      const me = await own(addr);
      const s = await sessionOf(me.address);
      const accountId = s.primaryAccounts[CALENDARS]!;
      return server(() => stalwart.upload(me.address, pathOf(s.uploadUrl).replace("{accountId}", encodeURIComponent(accountId)), type, data));
    },

    /** Everyone with a mailbox, the rooms and the teams: whom to invite, book and share with. */
    async directory(addr: string) {
      await own(addr);
      const names = await directoryNames();
      const { accounts: list, names: domains } = await accounts();
      const byAddress = new Map(list.map((a) => [addressOf(a, domains), a]));
      const persons: Person[] = (await people())
        .map((p) => ({
          address: p.address,
          name: names.get(p.address)?.name ?? p.account.description ?? p.address,
          principalId: p.account.id,
          groups: names.get(p.address)?.groups ?? [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        source: directory ? ("identity" as const) : ("mail-server" as const),
        people: persons,
        rooms: config.rooms.map((r) => ({ ...r, principalId: byAddress.get(r.address)?.id ?? null })),
        teams: config.teams.map((t) => ({ address: t.address, name: t.name, members: t.members, principalId: byAddress.get(t.address)?.id ?? null })),
      };
    },

    /**
     * When each of these people and rooms is busy between two times, never what they do: Calendar asks each one's
     * account for its own availability, so colleagues see free and busy without sharing anything.
     */
    async availability(addr: string, who: unknown, from: unknown, to: unknown) {
      await own(addr);
      const start = typeof from === "string" ? Date.parse(from) : NaN;
      const end = typeof to === "string" ? Date.parse(to) : NaN;
      if (!Array.isArray(who) || who.length < 1 || who.length > 30 || who.some((w) => typeof w !== "string"))
        throw new CalendarError(422, "invalid-body", "people is a list of 1 to 30 addresses.");
      if (!(start < end) || end - start > 62 * DAY) throw new CalendarError(422, "invalid-body", "from and to are times up to 62 days apart, from first.");
      const known = new Set([...(await people()).map((p) => p.address), ...config.rooms.map((r) => r.address)]);
      const out: Record<string, Array<{ start: string; end: string; status: string }> | null> = {};
      await Promise.all(
        (who as string[]).map(async (w) => {
          const a = w.trim().toLowerCase();
          if (!known.has(a)) return void (out[a] = null);
          try {
            const s = await sessionOf(a);
            const id = s.primaryAccounts[CALENDARS];
            if (!id) return void (out[a] = null);
            const [[, r]] = (await as(a, [
              [
                "Principal/getAvailability",
                { accountId: id, id, utcStart: new Date(start).toISOString(), utcEnd: new Date(end).toISOString(), showDetails: false },
                "0",
              ],
            ])) as [Invocation];
            out[a] = (r.list as Array<{ utcStart: string; utcEnd: string; busyStatus: string }>).map((b) => ({
              start: b.utcStart,
              end: b.utcEnd,
              status: b.busyStatus,
            }));
          } catch {
            out[a] = null;
          }
        }),
      );
      return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), busy: out };
    },

    /** Every room's accepted bookings between two times; private events show only as busy. */
    async roomBookings(addr: string, from: unknown, to: unknown) {
      await own(addr);
      const start = typeof from === "string" ? Date.parse(from) : NaN;
      const end = typeof to === "string" ? Date.parse(to) : NaN;
      if (!(start < end) || end - start > 32 * DAY) throw new CalendarError(422, "invalid-body", "from and to are times up to 32 days apart, from first.");
      const names = new Map((await people()).map((p) => [p.address, p.account.description ?? p.address]));
      const iso = (t: number) => new Date(t).toISOString().slice(0, 19);
      const rooms = await Promise.all(
        config.rooms.map(async (room) => {
          try {
            const s = await sessionOf(room.address);
            const accountId = s.primaryAccounts[CALENDARS];
            if (!accountId) return { address: room.address, bookings: [], error: true };
            const r = await as(room.address, [
              ["CalendarEvent/query", { accountId, filter: { after: iso(start), before: iso(end) }, expandRecurrences: true }, "0"],
              [
                "CalendarEvent/get",
                {
                  accountId,
                  "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" },
                  properties: ["uid", "baseEventId", "title", "privacy", "status", "participants", "organizerCalendarAddress", "utcStart", "utcEnd"],
                },
                "1",
              ],
            ]);
            const list = r[1]![1].list as Array<Record<string, any>>;
            // A moved occurrence carries only what changed; its title is the series'.
            const bases = new Map<string, Record<string, any>>();
            const missing = [...new Set(list.filter((e) => e.baseEventId && e.title === undefined).map((e) => e.baseEventId as string))];
            if (missing.length) {
              const [[, b]] = (await as(room.address, [
                ["CalendarEvent/get", { accountId, ids: missing, properties: ["title", "privacy", "participants", "organizerCalendarAddress"] }, "0"],
              ])) as [Invocation];
              for (const e of b.list as Array<Record<string, any>>) bases.set(e.id, e);
            }
            const bookings = list
              .map((e) => ({ ...bases.get(e.baseEventId), ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) }))
              .filter((e) => {
                if (e.status === "cancelled") return false;
                const me = Object.values((e.participants ?? {}) as Record<string, { calendarAddress?: string; participationStatus?: string }>).find(
                  (p) => p.calendarAddress?.toLowerCase() === `mailto:${room.address}`,
                );
                return me?.participationStatus === "accepted";
              })
              .map((e) => {
                const organizer = String(e.organizerCalendarAddress ?? "")
                  .replace(/^mailto:/i, "")
                  .toLowerCase();
                const hidden = e.privacy === "private" || e.privacy === "secret";
                return {
                  start: e.utcStart as string,
                  end: e.utcEnd as string,
                  title: hidden ? null : ((e.title as string | undefined) ?? null),
                  organizer: organizer || null,
                  organizerName: organizer ? (names.get(organizer) ?? organizer) : null,
                  mine: organizer === addr.toLowerCase(),
                };
              })
              .sort((a, b) => a.start.localeCompare(b.start));
            return { address: room.address, bookings, error: false };
          } catch {
            return { address: room.address, bookings: [], error: true };
          }
        }),
      );
      const week = new Date(clock() - 7 * DAY).toISOString();
      const answers = db.prepare("SELECT answer, COUNT(*) AS n FROM room_answers WHERE at >= ? GROUP BY answer").all(week) as Array<{
        answer: string;
        n: number;
      }>;
      return {
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        rooms: config.rooms.map((room, i) => ({ ...room, bookings: rooms[i]!.bookings, unavailable: rooms[i]!.error })),
        lastWeek: { accepted: answers.find((a) => a.answer === "accepted")?.n ?? 0, declined: answers.find((a) => a.answer === "declined")?.n ?? 0 },
        answers: (
          db.prepare("SELECT at, room, title, organizer, answer, reason FROM room_answers ORDER BY id DESC LIMIT 20").all() as Array<Record<string, string>>
        ).map((a) => ({ ...a, title: a.title ?? null, organizer: a.organizer ?? null })),
      };
    },

    /** A calendar as one .ics file. */
    async exportCalendar(addr: string, accountId: string, calendarId: string) {
      const me = await own(addr);
      return calendarIcs(me.address, accountId, calendarId);
    },

    /** An address book as one .vcf file. */
    async exportContacts(addr: string, accountId: string, addressBookId: string) {
      const me = await own(addr);
      const account = await accountIn(me.address, accountId);
      const [[, got]] = (await as(me.address, [["AddressBook/get", { accountId, ids: [addressBookId], properties: ["name", "isDefault"] }, "0"]])) as [
        Invocation,
      ];
      const book = (got.list as Array<{ name: string; isDefault?: boolean }>)[0];
      if (!book) throw new CalendarError(404, "not-found", "No such address book.");
      const href = await collectionOf(me.address, "card", account.address, book.name, book.isDefault === true);
      return { name: book.name, vcf: joinCards(davData(await server(() => stalwart.dav(me.address, "REPORT", href, ADDRESSBOOK_QUERY)), "address-data")) };
    },

    /** The secret links a person published their calendars at. */
    subscriptions(addr: string) {
      return (
        db
          .prepare("SELECT id, account_id, calendar_id, name, busy, created_at, used_at FROM subscriptions WHERE owner = ? ORDER BY created_at")
          .all(addr.toLowerCase()) as Array<Record<string, string | number | null>>
      ).map((r) => ({
        id: r.id,
        accountId: r.account_id,
        calendarId: r.calendar_id,
        name: r.name,
        busy: r.busy === 1,
        createdAt: r.created_at,
        usedAt: r.used_at,
      }));
    },
    async addSubscription(addr: string, body: unknown) {
      const me = await own(addr);
      const b = (body ?? {}) as { accountId?: unknown; calendarId?: unknown; busy?: unknown };
      if (typeof b.accountId !== "string" || typeof b.calendarId !== "string" || typeof b.busy !== "boolean")
        throw new CalendarError(422, "invalid-body", "accountId, calendarId and busy (true for free and busy only).");
      await accountIn(me.address, b.accountId);
      const [[, got]] = (await as(me.address, [["Calendar/get", { accountId: b.accountId, ids: [b.calendarId], properties: ["name"] }, "0"]])) as [Invocation];
      const cal = (got.list as Array<{ name: string }>)[0];
      if (!cal) throw new CalendarError(404, "not-found", "No such calendar.");
      if ((this.subscriptions(me.address) as unknown[]).length >= 20) throw new CalendarError(422, "invalid-body", "Up to 20 links; remove one first.");
      const token = randomBytes(24).toString("base64url");
      const id = randomUUID();
      const at = new Date(clock()).toISOString();
      db.prepare("INSERT INTO subscriptions (id, token_hash, owner, account_id, calendar_id, name, busy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        hash(token),
        me.address,
        b.accountId,
        b.calendarId,
        cal.name,
        b.busy ? 1 : 0,
        at,
      );
      return {
        id,
        accountId: b.accountId,
        calendarId: b.calendarId,
        name: cal.name,
        busy: b.busy,
        createdAt: at,
        usedAt: null,
        url: `${publicUrl}/ics/${token}.ics`,
      };
    },
    removeSubscription(addr: string, id: string) {
      const r = db.prepare("DELETE FROM subscriptions WHERE id = ? AND owner = ?").run(id, addr.toLowerCase());
      if (!r.changes) throw new CalendarError(404, "not-found", "No such link.");
    },
    /** The calendar behind a secret link, as its owner sees it, or free and busy only. Null when the link is unknown. */
    async published(token: string, busyLabel = "Busy"): Promise<{ name: string; ics: string } | null> {
      const row = db.prepare("SELECT id, owner, account_id, calendar_id, busy FROM subscriptions WHERE token_hash = ?").get(hash(token)) as
        { id: string; owner: string; account_id: string; calendar_id: string; busy: number } | undefined;
      if (!row) return null;
      try {
        await own(row.owner);
      } catch (err) {
        if (err instanceof CalendarError && err.code === "no-mailbox") return null;
        throw err;
      }
      const out = await calendarIcs(row.owner, row.account_id, row.calendar_id, row.busy ? busyLabel : undefined);
      db.prepare("UPDATE subscriptions SET used_at = ? WHERE id = ?").run(new Date(clock()).toISOString(), row.id);
      return out;
    },

    /** People who left: accounts Mail disabled, with the meetings they organize from now on, for an admin to hand over. */
    async leavers() {
      // Read fresh: someone may have left a moment ago.
      accountCache = null;
      const { accounts: list, names } = await accounts();
      const gone = list.filter((a) => a["@type"] === "User" && !isOurs(a) && isDisabled(a) && (a.roles?.["@type"] ?? "User") === "User");
      const now = new Date(clock()).toISOString().slice(0, 19);
      return Promise.all(
        gone.map(async (a) => {
          const address = addressOf(a, names);
          try {
            const r = await asService([
              ["CalendarEvent/query", { accountId: a.id, filter: { after: now } }, "0"],
              [
                "CalendarEvent/get",
                {
                  accountId: a.id,
                  "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" },
                  properties: ["uid", "title", "start", "timeZone", "recurrenceRule", "organizerCalendarAddress", "participants", "utcStart"],
                },
                "1",
              ],
            ]);
            const meetings = (r[1]![1].list as Array<Record<string, any>>)
              .filter((e) => String(e.organizerCalendarAddress ?? "").toLowerCase() === `mailto:${address}` && Object.keys(e.participants ?? {}).length > 1)
              .map((e) => ({
                id: e.id as string,
                title: (e.title as string | undefined) ?? "",
                start: e.start as string,
                timeZone: (e.timeZone as string | null | undefined) ?? null,
                repeats: !!e.recurrenceRule,
                guests: Object.values((e.participants ?? {}) as Record<string, { calendarAddress?: string }>).filter(
                  (p) => p.calendarAddress?.toLowerCase() !== `mailto:${address}`,
                ).length,
              }))
              .sort((x, y) => x.start.localeCompare(y.start));
            return { address, name: a.description ?? address, meetings };
          } catch {
            return { address, name: a.description ?? address, meetings: [] };
          }
        }),
      );
    },

    /**
     * Hands a leaver's meetings to someone else: each is made again in the new organizer's calendar with the same
     * guests, who get a new invitation, and the old one is cancelled, which tells them so.
     */
    async handOver(from: unknown, to: unknown, ids: unknown, cancelOnly = false) {
      if (
        typeof from !== "string" ||
        (!cancelOnly && typeof to !== "string") ||
        !Array.isArray(ids) ||
        ids.some((i) => typeof i !== "string") ||
        ids.length > 500
      )
        throw new CalendarError(422, "invalid-body", cancelOnly ? "from and ids, the meetings to cancel." : "from, to and ids, the meetings to hand over.");
      const leaver = (await this.leavers()).find((l) => l.address === from.toLowerCase());
      if (!leaver) throw new CalendarError(404, "not-found", `${from} is not someone who left.`);
      const { accounts: list, names } = await accounts();
      const account = list.find((a) => addressOf(a, names) === leaver.address)!;
      const chosen = leaver.meetings.filter((m) => (ids as string[]).includes(m.id));
      if (!chosen.length) return { done: 0 };
      if (!cancelOnly) {
        const heir = await own(to as string);
        const s = await sessionOf(heir.address);
        const heirAccount = s.primaryAccounts[CALENDARS]!;
        const [[, cals], [, events]] = (await Promise.all([
          as(heir.address, [["Calendar/get", { accountId: heirAccount, properties: ["isDefault"] }, "0"]]),
          asService([["CalendarEvent/get", { accountId: account.id, ids: chosen.map((m) => m.id) }, "0"]]),
        ]).then(([a, b]) => [a[0], b[0]])) as [Invocation, Invocation];
        const calendarId = ((cals.list as Array<{ id: string; isDefault?: boolean }>).find((c) => c.isDefault) ?? (cals.list as Array<{ id: string }>)[0])!.id;
        const create: Record<string, unknown> = {};
        for (const [i, e] of (events.list as Array<Record<string, any>>).entries()) {
          const participants: Record<string, Record<string, unknown>> = Object.fromEntries(
            Object.entries((e.participants ?? {}) as Record<string, Record<string, unknown>>)
              .filter(([, p]) => String(p.calendarAddress ?? "").toLowerCase() !== `mailto:${leaver.address}`)
              .map(([k, p]) => [k, { ...p, participationStatus: "needs-action", expectReply: true, roles: { attendee: true } }]),
          );
          participants.organizer = {
            "@type": "Participant",
            name: heir.account.description ?? heir.address,
            calendarAddress: `mailto:${heir.address}`,
            roles: { owner: true, attendee: true },
            participationStatus: "accepted",
          };
          const { id: _id, uid: _uid, calendarIds: _c, isDraft: _d, isOrigin: _o, updated: _u, created: _cr, sequence: _s, ...rest } = e;
          create[`e${i}`] = { ...rest, calendarIds: { [calendarId]: true }, organizerCalendarAddress: `mailto:${heir.address}`, participants };
        }
        await as(heir.address, [["CalendarEvent/set", { accountId: heirAccount, sendSchedulingMessages: true, create }, "0"]]);
      }
      await asService([["CalendarEvent/set", { accountId: account.id, sendSchedulingMessages: true, destroy: chosen.map((m) => m.id) }, "0"]]);
      log("info", cancelOnly ? "meetings of someone who left cancelled" : "meetings of someone who left handed over", {
        from: leaver.address,
        to,
        meetings: chosen.length,
      });
      return { done: chosen.length };
    },

    /** The passwords for a person's own calendar and mail apps; the secrets are never shown again. */
    async devices(addr: string): Promise<AppPassword[]> {
      const me = await own(addr);
      return server(() => stalwart.appPasswords(me.account.id));
    },
    async addDevice(addr: string, name: unknown): Promise<{ id: string; description: string; secret: string; username: string }> {
      const me = await own(addr);
      if (typeof name !== "string" || !name.trim() || name.trim().length > 64)
        throw new CalendarError(422, "invalid-body", "name is 1 to 64 characters, such as iPhone.");
      const p = await server(() => stalwart.createAppPassword(me.account.id, name.trim()));
      return { id: p.id, description: name.trim(), secret: p.secret, username: me.address };
    },
    async removeDevice(addr: string, deviceId: string): Promise<void> {
      const me = await own(addr);
      await server(async () => {
        if (!(await stalwart.appPasswords(me.account.id)).some((p) => p.id === deviceId)) throw new CalendarError(404, "not-found", "No such device password.");
        await stalwart.deleteAppPassword(me.account.id, deviceId);
      });
    },

    gauges() {
      return { teams: config.teams.length, rooms: config.rooms.length, syncOk: last ? last.ok : null };
    },
  };
}

export type Calendar = ReturnType<typeof createCalendar>;
