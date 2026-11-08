// End to end against a running Stalwart (e2e/run.sh starts one): its first start as Mail does it, then Calendar's own
// through server/stalwart-setup.ts, and Calendar's server with the calendar file applied: a team calendar, rooms that
// answer for themselves, a recurring meeting across time zones with a moved and a skipped time, invitations answered
// inside the company and sent by email outside it, free and busy without details, exports and subscription links,
// contacts, a device password over CalDAV, and the meetings of someone who left handed over, each checked in Stalwart.
//
//   SW=http://localhost:18280 SW_RECOVERY=... SW_CONTAINER=calendar-e2e-sw node e2e/stalwart.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp } from "../server/app.ts";
import { createCalendar } from "../server/calendar.ts";
import { parseConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { CORE, createStalwart, MANAGEMENT } from "../server/stalwart.ts";
import { setUpStalwart } from "../server/stalwart-setup.ts";

const SW = (process.env.SW ?? "http://localhost:18280").replace(/\/$/, "");
const RECOVERY = `admin:${process.env.SW_RECOVERY ?? ""}`;
const CONTAINER = process.env.SW_CONTAINER ?? "calendar-e2e-sw";
const SERVICE_PASSWORD = "e2e-calendar-service-password-0123456789";

let failures = 0;
async function step(name: string, work: () => Promise<void>) {
  try {
    await work();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${(err as Error).stack?.split("\n").slice(0, 6).join("\n  ")}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(work: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(1000);
    }
  }
}

/** Stalwart itself, as its recovery admin: to do what Mail does, and to check what Calendar did. */
async function admin(methodCalls: unknown[]): Promise<any[]> {
  const res = await fetch(`${SW}/jmap/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(RECOVERY).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ using: [CORE, MANAGEMENT], methodCalls }),
    signal: AbortSignal.timeout(15_000),
  });
  return ((await res.json()) as { methodResponses: any[] }).methodResponses;
}

await step("Calendar's setup waits for Mail's first start, then makes its own service account, and runs again", async () => {
  const o = { url: SW, recovery: RECOVERY, user: "openasy-calendar", password: SERVICE_PASSWORD };
  await assert.rejects(setUpStalwart(o), /Mail's/);
  // Mail's first start (mail/server/stalwart-setup.ts): the host name and first domain, then one restart.
  const [[name, r]] = await admin([
    ["x:Bootstrap/set", { update: { singleton: { serverHostname: "mail.example.com", defaultDomain: "example.com", requestTlsCertificate: false } } }, "0"],
  ]);
  assert.equal(name, "x:Bootstrap/set", JSON.stringify(r));
  execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" });
  assert.equal(await eventually(() => setUpStalwart(o)), "created");
  assert.equal(await setUpStalwart(o), "updated");
});

// Mail's mailboxes, as Mail's sync makes them.
await step("the mailboxes Mail would make are there", async () => {
  const [[, d]] = await admin([["x:Domain/get", { properties: ["name"] }, "0"]]);
  const domainId = d.list.find((x: { name: string }) => x.name === "example.com").id;
  const user = (name: string, description: string) => ({
    "@type": "User",
    name,
    domainId,
    description,
    roles: { "@type": "User" },
    encryptionAtRest: { "@type": "Disabled" },
  });
  const [[, made]] = await admin([
    ["x:Account/set", { create: { j: user("jane", "Jane Doe"), a: user("ali", "Ali Yılmaz"), m: user("mark", "Mark Lee") } }, "0"],
  ]);
  assert.equal(Object.keys(made.created ?? {}).length, 3, JSON.stringify(made));
});

const stalwart = createStalwart({ url: SW, user: "openasy-calendar", password: SERVICE_PASSWORD });
const db = openDb(":memory:");
const calendar = createCalendar(db, stalwart, { davUrl: SW, publicUrl: "http://calendar.test" });

let handler: RequestListener = (_req, res) => res.writeHead(503).end();
const server: Server = createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const auth = createAuth({ db, product: "calendar", productName: "OpenAsy Calendar", origin: base, users: true });
const JANE = "e2e-jane";
const ALI = "e2e-ali";
const MARK = "e2e-mark";
handler = createApp({
  db,
  calendar,
  auth,
  adminToken: "e2e-admin",
  personTokens: { [JANE]: "jane@example.com", [ALI]: "ali@example.com", [MARK]: "mark@example.com" },
  version: "0.0.0",
});
async function as<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 300)}`), { status: res.status });
  return (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
}
const statusOf = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:contacts", "urn:ietf:params:jmap:calendars:parse"];
async function jmap(token: string, methodCalls: unknown[]): Promise<any[]> {
  const r = await as<{ methodResponses: any[] }>(token, "/api/v1/jmap", { method: "POST", body: JSON.stringify({ using: USING, methodCalls }) });
  return r.methodResponses;
}
const FILE = (extra = "") => `
teams:
  - { address: sales-team@example.com, name: Sales team, members: [jane@example.com, ali@example.com, nobody@example.com] }
rooms:
  - { address: lisbon@rooms.example.com, name: Lisbon, seats: 6, location: 3rd floor, features: [Screen] }
  - { address: atlas@rooms.example.com, name: Atlas, seats: 14, bookers: [jane@example.com] }
${extra}`;

await step("the calendar file makes a team and its members, and rooms with their own role, and changes nothing the second time", async () => {
  const r = await calendar.setConfig(parseConfig(FILE()));
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(r.created.sort(), ["atlas@rooms.example.com", "lisbon@rooms.example.com", "sales-team@example.com"]);
  assert.deepEqual(r.warnings, ["sales-team@example.com: nobody@example.com is not a mailbox on the mail server yet."]);
  const [[, got]] = await admin([["x:Account/get", { properties: ["name", "externalId", "roles", "memberGroupIds", "@type"] }, "0"]]);
  const by = (n: string) => got.list.find((a: { name: string }) => a.name === n);
  assert.equal(by("sales-team")["@type"], "Group");
  assert.ok(by("jane").memberGroupIds[by("sales-team").id], "Jane is in the team");
  assert.equal(by("lisbon").roles["@type"], "Custom", "a room is not a User Mail would disable");
  assert.equal(by("lisbon").externalId, "openasy-calendar:room");
  const again = await calendar.syncNow();
  assert.equal(again.ok, true, again.error ?? "");
  assert.deepEqual([again.created, again.updated, again.disabled], [[], [], []]);
});

let jane: any;
await step("Jane's session has her own calendar and her team's; the team's calendar is named after it", async () => {
  jane = await as(JANE, "/api/v1/session");
  assert.equal(jane.address, "jane@example.com");
  assert.deepEqual(
    jane.accounts.map((a: { kind: string; name: string }) => [a.kind, a.name]),
    [
      ["own", "Jane Doe"],
      ["team", "Sales team"],
    ],
  );
  const team = jane.accounts.find((a: { kind: string }) => a.kind === "team");
  const [[, cals]] = await jmap(JANE, [["Calendar/get", { accountId: team.id }, "0"]]);
  assert.equal(cals.list[0].name, "Sales team");
  assert.equal(cals.list[0].myRights.mayWriteAll, true);
});

const accountOf = async (token: string) => (await as(token, "/api/v1/session")).accountId as string;
const defaultCalendar = async (token: string, accountId: string) =>
  ((await jmap(token, [["Calendar/get", { accountId }, "0"]]))[0][1].list as Array<{ id: string; isDefault: boolean }>).find((c) => c.isDefault)!.id;
const participant = (name: string, email: string, extra: Record<string, unknown> = {}) => ({
  "@type": "Participant",
  name,
  calendarAddress: `mailto:${email}`,
  roles: { attendee: true },
  participationStatus: "needs-action",
  expectReply: true,
  ...extra,
});
// Monday 7 December 2026 is far enough ahead for the rooms and inside their window.
const SERIES = {
  "@type": "Event",
  title: "Weekly demo",
  start: "2026-12-07T14:00:00",
  timeZone: "Europe/Istanbul",
  duration: "PT1H",
  recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", count: 4 },
  organizerCalendarAddress: "mailto:jane@example.com",
};
const { recurrenceRule: _rule, ...ONE } = SERIES;
const PARTICIPANTS = {
  jane: participant("Jane Doe", "jane@example.com", { roles: { owner: true, attendee: true }, participationStatus: "accepted", expectReply: false }),
  ali: participant("Ali Yılmaz", "ali@example.com"),
  dana: participant("Dana Brooks", "dana@northwind.test"),
  lisbon: participant("Lisbon", "lisbon@rooms.example.com", { kind: "location" }),
};
let demoId = "";
let demoUid = "";

await step("Jane invites Ali, a customer and a room to a weekly meeting with one time moved and one skipped", async () => {
  const accountId = jane.accountId;
  const calendarId = await defaultCalendar(JANE, accountId);
  const r = await jmap(JANE, [
    [
      "CalendarEvent/set",
      {
        accountId,
        sendSchedulingMessages: true,
        create: {
          e: {
            ...SERIES,
            calendarIds: { [calendarId]: true },
            participants: PARTICIPANTS,
            // A moved time carries the whole event, so every calendar shows it in full (see the README).
            recurrenceOverrides: {
              "2026-12-14T14:00:00": { ...ONE, start: "2026-12-14T16:00:00", participants: PARTICIPANTS },
              "2026-12-21T14:00:00": { excluded: true },
            },
          },
        },
      },
      "0",
    ],
  ]);
  demoId = r[0][1].created?.e?.id;
  assert.ok(demoId, JSON.stringify(r[0]));
  const [[, q], [, got]] = await jmap(JANE, [
    ["CalendarEvent/query", { accountId, filter: { after: "2026-12-01T00:00:00", before: "2027-01-10T00:00:00" }, expandRecurrences: true }, "0"],
    ["CalendarEvent/get", { accountId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" }, properties: ["uid", "utcStart", "utcEnd"] }, "1"],
  ]);
  assert.equal(q.ids.length, 3, "four weeks, one skipped");
  demoUid = got.list[0].uid;
  // Istanbul is UTC+3: 14:00 there is 11:00 UTC, and the moved one 13:00.
  assert.deepEqual(got.list.map((e: { utcStart: string }) => e.utcStart).sort(), ["2026-12-07T11:00:00Z", "2026-12-14T13:00:00Z", "2026-12-28T11:00:00Z"]);
});

await step("Ali finds the invitation in his calendar, with the moved time, and answers; Jane's copy shows his answer", async () => {
  const accountId = await accountOf(ALI);
  const ev = await eventually(async () => {
    const [[, q], [, got]] = await jmap(ALI, [
      [
        "CalendarEvent/query",
        { accountId, filter: { uid: demoUid, after: "2026-12-01T00:00:00", before: "2027-01-10T00:00:00" }, expandRecurrences: true },
        "0",
      ],
      ["CalendarEvent/get", { accountId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" }, properties: ["utcStart", "baseEventId"] }, "1"],
    ]);
    assert.equal(q.ids.length, 3, "not delivered yet");
    assert.ok(
      got.list.some((e: { utcStart: string }) => e.utcStart === "2026-12-14T13:00:00Z"),
      JSON.stringify(got.list),
    );
    return got.list[0].baseEventId as string;
  });
  const [[, notes]] = await jmap(ALI, [["CalendarEventNotification/get", { accountId }, "0"]]);
  assert.ok(notes.list.some((n: { changedBy?: { email?: string } }) => n.changedBy?.email === "jane@example.com"));
  const r = await jmap(ALI, [
    ["CalendarEvent/set", { accountId, sendSchedulingMessages: true, update: { [ev]: { "participants/ali/participationStatus": "accepted" } } }, "0"],
  ]);
  assert.ok(r[0][1].updated, JSON.stringify(r[0]));
  await eventually(async () => {
    const [[, got]] = await jmap(JANE, [["CalendarEvent/get", { accountId: jane.accountId, ids: [demoId], properties: ["participants"] }, "0"]]);
    assert.equal(got.list[0].participants.ali.participationStatus, "accepted", "Ali's answer not back yet");
  });
});

await step("the invitation to the customer goes out by email from the mail server", async () => {
  await eventually(async () => {
    const [[, q], [, got]] = await admin([
      ["x:QueuedMessage/query", {}, "0"],
      ["x:QueuedMessage/get", { "#ids": { resultOf: "0", name: "x:QueuedMessage/query", path: "/ids" } }, "1"],
    ]);
    assert.ok(q.ids.length > 0, "nothing queued");
    assert.ok(JSON.stringify(got.list).includes("dana@northwind.test"), JSON.stringify(got.list).slice(0, 300));
  });
});

await step("a room accepts when it is free, declines a clash, and declines who may not book it", async () => {
  await calendar.answerRooms();
  await eventually(async () => {
    const [[, got]] = await jmap(JANE, [["CalendarEvent/get", { accountId: jane.accountId, ids: [demoId], properties: ["participants"] }, "0"]]);
    assert.equal(got.list[0].participants.lisbon.participationStatus, "accepted", "Lisbon has not answered");
  });
  const accountId = await accountOf(ALI);
  const calendarId = await defaultCalendar(ALI, accountId);
  const ali = participant("Ali Yılmaz", "ali@example.com", { roles: { owner: true, attendee: true }, participationStatus: "accepted", expectReply: false });
  const r = await jmap(ALI, [
    [
      "CalendarEvent/set",
      {
        accountId,
        sendSchedulingMessages: true,
        create: {
          clash: {
            "@type": "Event",
            title: "Clash",
            calendarIds: { [calendarId]: true },
            start: "2026-12-07T14:30:00",
            timeZone: "Europe/Istanbul",
            duration: "PT1H",
            organizerCalendarAddress: "mailto:ali@example.com",
            participants: { ali, lisbon: participant("Lisbon", "lisbon@rooms.example.com", { kind: "location" }) },
          },
          atlas: {
            "@type": "Event",
            title: "Not mine to book",
            calendarIds: { [calendarId]: true },
            start: "2026-12-08T10:00:00",
            timeZone: "Europe/Istanbul",
            duration: "PT1H",
            organizerCalendarAddress: "mailto:ali@example.com",
            participants: { ali, atlas: participant("Atlas", "atlas@rooms.example.com", { kind: "location" }) },
          },
        },
      },
      "0",
    ],
  ]);
  const { clash, atlas } = r[0][1].created;
  await eventually(async () => {
    await calendar.answerRooms();
    const [[, got]] = await jmap(ALI, [["CalendarEvent/get", { accountId, ids: [clash.id, atlas.id], properties: ["participants"] }, "0"]]);
    const by = Object.fromEntries(got.list.map((e: any) => [e.id, e.participants]));
    assert.equal(by[clash.id].lisbon.participationStatus, "declined", "no answer to the clash yet");
    assert.equal(by[atlas.id].atlas.participationStatus, "declined", "no answer from Atlas yet");
  });
  const rooms = await as(JANE, "/api/v1/rooms?from=2026-12-07T00:00:00Z&to=2026-12-08T00:00:00Z");
  const lisbon = rooms.rooms.find((x: { address: string }) => x.address === "lisbon@rooms.example.com");
  assert.deepEqual(
    lisbon.bookings.map((b: any) => [b.title, b.start, b.mine]),
    [["Weekly demo", "2026-12-07T11:00:00Z", true]],
  );
  assert.equal(rooms.lastWeek.declined, 2);
});

await step("colleagues see when Ali is busy, never what it is", async () => {
  const r = await as(JANE, "/api/v1/availability", {
    method: "POST",
    body: JSON.stringify({
      people: ["ali@example.com", "lisbon@rooms.example.com", "dana@northwind.test"],
      from: "2026-12-07T00:00:00Z",
      to: "2026-12-09T00:00:00Z",
    }),
  });
  assert.ok(
    r.busy["ali@example.com"].some((b: { start: string }) => b.start === "2026-12-07T11:00:00Z"),
    JSON.stringify(r.busy),
  );
  assert.ok(r.busy["lisbon@rooms.example.com"].length >= 1);
  assert.equal(r.busy["dana@northwind.test"], null, "outside the company: unknown");
  assert.ok(!JSON.stringify(r).includes("Weekly demo"));
});

await step("a calendar exports as one .ics, and its subscription link can show free and busy only", async () => {
  const calendarId = await defaultCalendar(JANE, jane.accountId);
  const ics = await as<string>(JANE, `/api/v1/export/calendars/${jane.accountId}/${calendarId}`);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;COUNT=4/);
  assert.match(ics, /SUMMARY:Weekly demo/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  const link = await as(JANE, "/api/v1/subscriptions", { method: "POST", body: JSON.stringify({ accountId: jane.accountId, calendarId, busy: true }) });
  const token = /\/ics\/([^/]+)\.ics$/.exec(link.url)![1];
  const busy = await (await fetch(`${base}/ics/${token}.ics`)).text();
  assert.match(busy, /SUMMARY:Busy/);
  assert.match(busy, /RRULE:FREQ=WEEKLY;COUNT=4/);
  assert.doesNotMatch(busy, /Weekly demo|ATTENDEE|dana@/);
  await as(JANE, `/api/v1/subscriptions/${link.id}`, { method: "DELETE" });
  assert.equal((await fetch(`${base}/ics/${token}.ics`)).status, 404);
});

await step("an .ics file from another provider is read by the mail server and saved as events", async () => {
  const ics =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//old//EN\r\nBEGIN:VEVENT\r\nUID:imported-1@old.example\r\nDTSTAMP:20261101T000000Z\r\nDTSTART;TZID=America/New_York:20261210T090000\r\nDTEND;TZID=America/New_York:20261210T100000\r\nSUMMARY:Imported call\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const up = await as(JANE, "/api/v1/upload", { method: "POST", body: ics, headers: { "content-type": "text/calendar" } });
  const [[, parsed]] = await jmap(JANE, [["CalendarEvent/parse", { accountId: jane.accountId, blobIds: [up.blobId] }, "0"]]);
  const event = parsed.parsed[up.blobId][0];
  assert.equal(event.title, "Imported call");
  const calendarId = await defaultCalendar(JANE, jane.accountId);
  const { iCalendar: _i, ...plain } = event;
  const [[, made]] = await jmap(JANE, [
    ["CalendarEvent/set", { accountId: jane.accountId, create: { i: { ...plain, calendarIds: { [calendarId]: true } } } }, "0"],
  ]);
  assert.ok(made.created?.i, JSON.stringify(made));
});

await step("contacts with a group are kept in the address book and export as vCard", async () => {
  const [[, books]] = await jmap(JANE, [["AddressBook/get", { accountId: jane.accountId }, "0"]]);
  const book = books.list[0].id;
  const [[, made]] = await jmap(JANE, [
    [
      "ContactCard/set",
      {
        accountId: jane.accountId,
        create: {
          dana: {
            "@type": "Card",
            version: "1.0",
            uid: "urn:uuid:dana-e2e",
            kind: "individual",
            addressBookIds: { [book]: true },
            name: { full: "Dana Brooks" },
            emails: { e: { address: "dana@northwind.test" } },
          },
          group: {
            "@type": "Card",
            version: "1.0",
            kind: "group",
            addressBookIds: { [book]: true },
            name: { full: "Northwind" },
            members: { "urn:uuid:dana-e2e": true },
          },
        },
      },
      "0",
    ],
  ]);
  assert.ok(made.created?.dana && made.created?.group, JSON.stringify(made));
  const vcf = await as<string>(JANE, `/api/v1/export/addressbooks/${jane.accountId}/${book}`);
  assert.match(vcf, /FN:Dana Brooks/);
  assert.match(vcf, /FN:Northwind/);
});

await step("a device password reads the calendars over CalDAV, and stops when it is removed", async () => {
  const d = await as(JANE, "/api/v1/devices", { method: "POST", body: JSON.stringify({ name: "iPhone" }) });
  const propfind = () =>
    fetch(`${SW}/dav/cal/jane%40example.com/`, {
      method: "PROPFIND",
      headers: { authorization: `Basic ${Buffer.from(`${d.username}:${d.secret}`).toString("base64")}`, depth: "1" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>',
    });
  await eventually(async () => assert.equal((await propfind()).status, 207));
  await fetch(`${base}/api/v1/devices/${d.id}`, { method: "DELETE", headers: { authorization: `Bearer ${JANE}` } });
  await eventually(async () => assert.equal((await propfind()).status, 401));
});

await step("the pages cannot reach mail, management, or another person's calendar", async () => {
  assert.equal(await statusOf(jmap(JANE, [["x:Account/get", {}, "0"]])), 403);
  assert.equal(await statusOf(jmap(JANE, [["Email/query", { accountId: jane.accountId }, "0"]])), 403);
  const ali = await accountOf(ALI);
  const r = await jmap(JANE, [["CalendarEvent/query", { accountId: ali, filter: {} }, "0"]]);
  assert.equal(r[0][0], "error", JSON.stringify(r[0]));
});

await step("when someone leaves, their meetings are listed and handed over: the guests are invited again and the old one is cancelled", async () => {
  const accountId = await accountOf(MARK);
  const calendarId = await defaultCalendar(MARK, accountId);
  const mark = participant("Mark Lee", "mark@example.com", { roles: { owner: true, attendee: true }, participationStatus: "accepted", expectReply: false });
  const [[, made]] = await jmap(MARK, [
    [
      "CalendarEvent/set",
      {
        accountId,
        sendSchedulingMessages: true,
        create: {
          m: {
            "@type": "Event",
            title: "Customer review",
            calendarIds: { [calendarId]: true },
            start: "2026-12-15T10:00:00",
            timeZone: "Europe/Istanbul",
            duration: "PT30M",
            organizerCalendarAddress: "mailto:mark@example.com",
            participants: { mark, ali: participant("Ali Yılmaz", "ali@example.com") },
          },
        },
      },
      "0",
    ],
  ]);
  assert.ok(made.created?.m, JSON.stringify(made));
  const ali = await accountOf(ALI);
  const reviewInAli = async () => {
    const [[, q], [, got]] = await jmap(ALI, [
      ["CalendarEvent/query", { accountId: ali, filter: { after: "2026-12-15T00:00:00", before: "2026-12-16T00:00:00" } }, "0"],
      [
        "CalendarEvent/get",
        { accountId: ali, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" }, properties: ["title", "organizerCalendarAddress", "status"] },
        "1",
      ],
    ]);
    // The weekly demo spans this day too; only the review counts.
    const list = (got.list as Array<{ title: string; organizerCalendarAddress: string; status?: string }>).filter((e) => e.title === "Customer review");
    return { ids: q.ids as string[], list };
  };
  await eventually(async () => assert.equal((await reviewInAli()).list.length, 1, "Ali has no invitation yet"));
  // Mark leaves: Mail disables his account.
  const [[, accounts]] = await admin([["x:Account/get", { properties: ["name"] }, "0"]]);
  const markId = accounts.list.find((a: { name: string }) => a.name === "mark").id;
  await admin([
    [
      "x:Account/set",
      {
        update: {
          [markId]: {
            permissions: { "@type": "Merge", enabledPermissions: {}, disabledPermissions: { authenticate: true, emailReceive: true, emailSend: true } },
          },
        },
      },
      "0",
    ],
  ]);
  await sleep(1500);
  const { leavers } = await eventually(async () => {
    const r = await as("e2e-admin", "/api/v1/leavers");
    assert.ok(
      r.leavers.some((l: { address: string; meetings: unknown[] }) => l.address === "mark@example.com" && l.meetings.length === 1),
      JSON.stringify(r),
    );
    return r;
  });
  const meeting = leavers.find((l: { address: string }) => l.address === "mark@example.com").meetings[0];
  assert.equal(meeting.title, "Customer review");
  assert.equal(meeting.guests, 1);
  assert.equal((await as(JANE, "/api/v1/leavers").catch((e) => e)).status, 401, "only admins");
  const r = await as("e2e-admin", "/api/v1/leavers/mark@example.com/handover", {
    method: "POST",
    body: JSON.stringify({ to: "jane@example.com", ids: [meeting.id] }),
  });
  assert.equal(r.done, 1);
  await eventually(async () => {
    const got = await reviewInAli();
    const live = got.list.filter((e) => e.status !== "cancelled");
    assert.equal(live.length, 1, `Ali has ${JSON.stringify(got.list)}`);
    assert.equal(live[0]!.organizerCalendarAddress, "mailto:jane@example.com");
  });
  const after = (await as("e2e-admin", "/api/v1/leavers")).leavers.find((l: { address: string }) => l.address === "mark@example.com");
  assert.equal(after.meetings.length, 0);
});

await step("a team and a room taken out of the file: the team loses its members, the room stops taking invitations", async () => {
  const r = await calendar.setConfig(parseConfig("rooms:\n  - { address: atlas@rooms.example.com, name: Atlas }\n"));
  assert.equal(r.ok, true, r.error ?? "");
  assert.deepEqual(r.disabled.sort(), ["lisbon@rooms.example.com", "sales-team@example.com"]);
  const [[, got]] = await admin([["x:Account/get", { properties: ["name", "memberGroupIds", "permissions"] }, "0"]]);
  const by = (n: string) => got.list.find((a: { name: string }) => a.name === n);
  assert.ok(by("sales-team"), "the team's account and calendar stay");
  assert.deepEqual(by("jane").memberGroupIds ?? {}, {});
  assert.equal(by("lisbon").permissions["@type"], "Merge");
  const s = await as(JANE, "/api/v1/session");
  assert.deepEqual(
    s.accounts.map((a: { kind: string }) => a.kind),
    ["own"],
  );
});

server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
