import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, GONE, STRANGER, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const jmap = (methodCalls: unknown[], using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"]) => ({
  method: "POST",
  body: JSON.stringify({ using, methodCalls }),
});
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=Europe/Istanbul:20261109T100000\r\nDURATION:PT1H\r\nSUMMARY:Board review\r\nATTENDEE:mailto:ali@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

describe("administration", () => {
  it("shows the teams and rooms of the file, and the file as applied", async () => {
    const c = await json(await app.admin("/api/v1/config"));
    expect(c.teams.map((t: any) => t.address)).toEqual(["sales-team@example.com"]);
    expect(c.rooms.map((r: any) => [r.address, r.bookAhead])).toEqual([["lisbon@rooms.example.com", 180]]);
    const s = await json(await app.admin("/api/v1/summary"));
    expect(s).toMatchObject({ teams: 1, rooms: 1, davUrl: "https://mail.example.com", sync: { ok: true } });
  });

  it("brings the server in step on request and keeps the history", async () => {
    expect(await json(await app.admin("/api/v1/sync", { method: "POST" }))).toMatchObject({ ok: true, created: [], updated: [] });
    const history = await json(await app.admin("/api/v1/sync"));
    expect(history.runs.length).toBe(2);
    expect(history.runs[1]).toMatchObject({ ok: true, created: 2 });
  });

  it("is not open to people who only plan their day", async () => {
    expect((await app.jane("/api/v1/config")).status).toBe(401);
    expect((await app.jane("/api/v1/leavers")).status).toBe(401);
    expect((await fetch(`${app.base}/api/v1/summary`)).status).toBe(401);
  });
});

describe("a person's calendars", () => {
  it("gives Jane her own account and her team's, with the addresses for calendar apps", async () => {
    const s = await json(await app.jane("/api/v1/session"));
    expect(s.address).toBe("jane@example.com");
    expect(s.name).toBe("Jane Doe");
    expect(s.accounts.map((a: any) => [a.kind, a.name])).toEqual([
      ["own", "Jane Doe"],
      ["team", "Sales team"],
    ]);
    expect(s.dav).toEqual({
      server: "https://mail.example.com",
      calendars: "https://mail.example.com/dav/cal/jane@example.com/",
      contacts: "https://mail.example.com/dav/card/jane@example.com/",
    });
  });

  it("passes calendar methods on as that person, never mail or management", async () => {
    const s = await json(await app.jane("/api/v1/session"));
    const r = await json(await app.jane("/api/v1/jmap", jmap([["Calendar/get", { accountId: s.accountId }, "0"]])));
    expect(r.methodResponses[0][0]).toBe("Calendar/get");
    expect(app.fake.calls.at(-1)).toMatchObject({ as: "jane@example.com", method: "Calendar/get" });
    const before = app.fake.calls.length;
    for (const blocked of ["x:Account/get", "Email/query", "Principal/getAvailability"]) {
      const res = await app.jane("/api/v1/jmap", jmap([[blocked, {}, "0"]]));
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe("method-not-allowed");
    }
    expect(app.fake.calls.length).toBe(before);
    // A capability the pages may not use is dropped before the call goes on.
    await app.jane("/api/v1/jmap", jmap([["Core/echo", {}, "0"]], ["urn:ietf:params:jmap:core", "urn:stalwart:jmap", "urn:ietf:params:jmap:mail"]));
    expect(app.fake.calls.at(-1)).toMatchObject({ as: "jane@example.com", method: "Core/echo" });
    expect((await app.jane("/api/v1/jmap", { method: "POST", body: JSON.stringify({ using: [] }) })).status).toBe(400);
    expect((await app.jane("/api/v1/jmap", { method: "POST", body: "{" })).status).toBe(400);
  });

  it("refuses people without a mailbox, disabled ones, and API tokens", async () => {
    const stranger = await app.as(STRANGER)("/api/v1/session");
    expect(stranger.status).toBe(403);
    expect((await json(stranger)).detail).toBe("stranger@example.net has no mailbox on the mail server; Mail's domains file gives people one.");
    expect((await app.as(GONE)("/api/v1/session")).status).toBe(403);
    expect((await app.as(ADMIN_TOKEN)("/api/v1/session")).status).toBe(401);
    // Nor are rooms and teams people to sign in as.
    expect((await json(await app.jane("/api/v1/directory"))).people.map((p: any) => p.address)).toEqual(["ali@example.com", "jane@example.com"]);
  });

  it("lists the directory, the rooms and the teams", async () => {
    const d = await json(await app.jane("/api/v1/directory"));
    expect(d.source).toBe("mail-server");
    expect(d.people[1]).toMatchObject({ address: "jane@example.com", name: "Jane Doe" });
    expect(d.rooms[0]).toMatchObject({ address: "lisbon@rooms.example.com", name: "Lisbon", seats: 6 });
    expect(d.teams[0]).toMatchObject({ address: "sales-team@example.com", members: ["jane@example.com", "ali@example.com"] });
  });
});

describe("free and busy", () => {
  it("shows when colleagues and rooms are busy, asked as each of them, and nothing for outsiders", async () => {
    const ali = app.fake.accountByAddress("ali@example.com")!;
    app.fake.events.set(ali.id, [
      { id: "e1", uid: "u1", calendarIds: { b: true }, title: "Secret plan", utcStart: "2026-11-09T07:00:00Z", utcEnd: "2026-11-09T08:00:00Z" },
    ]);
    const res = await app.jane("/api/v1/availability", {
      method: "POST",
      body: JSON.stringify({
        people: ["ali@example.com", "lisbon@rooms.example.com", "dana@northwind.example"],
        from: "2026-11-09T00:00:00Z",
        to: "2026-11-10T00:00:00Z",
      }),
    });
    const r = await json(res);
    expect(r.busy["ali@example.com"]).toEqual([{ start: "2026-11-09T07:00:00Z", end: "2026-11-09T08:00:00Z", status: "confirmed" }]);
    expect(r.busy["lisbon@rooms.example.com"]).toEqual([]);
    expect(r.busy["dana@northwind.example"]).toBeNull();
    expect(JSON.stringify(r)).not.toContain("Secret plan");
    expect(app.fake.calls.find((c) => c.method === "Principal/getAvailability" && c.as === "ali@example.com")?.args.showDetails).toBe(false);
  });

  it("checks what it is asked", async () => {
    const bad = (body: unknown) => app.jane("/api/v1/availability", { method: "POST", body: JSON.stringify(body) }).then((r) => r.status);
    expect(await bad({ people: [], from: "2026-11-09T00:00:00Z", to: "2026-11-10T00:00:00Z" })).toBe(422);
    expect(await bad({ people: ["a@example.com"], from: "2026-11-10T00:00:00Z", to: "2026-11-09T00:00:00Z" })).toBe(422);
    expect(await bad({ people: ["a@example.com"], from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" })).toBe(422);
  });
});

describe("rooms", () => {
  it("lists accepted bookings, hiding private titles, and what rooms answered", async () => {
    const room = app.fake.accountByAddress("lisbon@rooms.example.com")!;
    const me = { calendarAddress: "mailto:lisbon@rooms.example.com", participationStatus: "accepted" };
    app.fake.events.set(room.id, [
      {
        id: "r1",
        uid: "u1",
        calendarIds: { b: true },
        title: "Demo",
        utcStart: "2026-11-09T11:00:00Z",
        utcEnd: "2026-11-09T12:00:00Z",
        organizerCalendarAddress: "mailto:jane@example.com",
        participants: { r: me },
      },
      {
        id: "r2",
        uid: "u2",
        calendarIds: { b: true },
        title: "Hidden",
        privacy: "private",
        utcStart: "2026-11-09T13:00:00Z",
        utcEnd: "2026-11-09T14:00:00Z",
        organizerCalendarAddress: "mailto:ali@example.com",
        participants: { r: me },
      },
      {
        id: "r3",
        uid: "u3",
        calendarIds: { b: true },
        title: "Declined",
        utcStart: "2026-11-09T15:00:00Z",
        utcEnd: "2026-11-09T16:00:00Z",
        participants: { r: { ...me, participationStatus: "declined" } },
      },
    ]);
    const r = await json(await app.jane("/api/v1/rooms?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z"));
    expect(r.rooms[0].bookings).toEqual([
      { start: "2026-11-09T11:00:00Z", end: "2026-11-09T12:00:00Z", title: "Demo", organizer: "jane@example.com", organizerName: "Jane Doe", mine: true },
      { start: "2026-11-09T13:00:00Z", end: "2026-11-09T14:00:00Z", title: null, organizer: "ali@example.com", organizerName: "Ali Yılmaz", mine: false },
    ]);
    expect(r.lastWeek).toEqual({ accepted: 0, declined: 0 });
  });
});

describe("files and links", () => {
  it("exports a calendar as one .ics file and an address book as .vcf", async () => {
    app.fake.state.ics = ICS;
    const s = await json(await app.jane("/api/v1/session"));
    const res = await app.jane(`/api/v1/export/calendars/${s.accountId}/b`);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toContain("SUMMARY:Board review");
    expect(await (await app.jane(`/api/v1/export/addressbooks/${s.accountId}/b`)).text()).toContain("FN:Dana Brooks");
    expect((await app.jane(`/api/v1/export/calendars/${s.accountId}/nope`)).status).toBe(404);
    expect((await app.jane(`/api/v1/export/calendars/someone-else/b`)).status).toBe(404);
  });

  it("publishes a calendar at a secret link, free and busy only if asked, until it is removed", async () => {
    const s = await json(await app.jane("/api/v1/session"));
    const made = await app.jane("/api/v1/subscriptions", { method: "POST", body: JSON.stringify({ accountId: s.accountId, calendarId: "b", busy: true }) });
    expect(made.status).toBe(201);
    const link = await json(made);
    expect(link.url).toMatch(/^https:\/\/calendar\.example\.com\/ics\/[A-Za-z0-9_-]{32}\.ics$/);
    const path = new URL(link.url).pathname;
    const ics = await (await fetch(app.base + path)).text();
    expect(ics).toContain("SUMMARY:Busy");
    expect(ics).not.toContain("Board review");
    expect(ics).not.toContain("ATTENDEE");
    const list = await json(await app.jane("/api/v1/subscriptions"));
    expect(list.subscriptions[0]).toMatchObject({ id: link.id, busy: true });
    expect(list.subscriptions[0].usedAt).not.toBeNull();
    expect(JSON.stringify(list)).not.toContain(path.slice(5, 30));
    // Only its owner removes it.
    expect((await app.ali(`/api/v1/subscriptions/${link.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.jane(`/api/v1/subscriptions/${link.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(app.base + path)).status).toBe(404);
    expect((await app.jane("/api/v1/subscriptions", { method: "POST", body: JSON.stringify({ accountId: s.accountId }) })).status).toBe(422);
  });

  it("puts an import on the mail server for it to read", async () => {
    const up = await json(await app.jane("/api/v1/upload", { method: "POST", body: ICS, headers: { "content-type": "text/calendar" } }));
    expect(up.blobId).toBeTruthy();
  });
});

describe("people who left", () => {
  it("lists their meetings for an admin, and hands them over: made again for the new organizer, cancelled for the old", async () => {
    const gone = app.fake.accountByAddress("gone@example.com")!;
    app.fake.events.set(gone.id, [
      {
        id: "g1",
        uid: "gu1",
        calendarIds: { b: true },
        title: "Customer review",
        start: "2026-12-01T10:00:00",
        timeZone: "Europe/Istanbul",
        duration: "PT1H",
        organizerCalendarAddress: "mailto:gone@example.com",
        participants: { o: { calendarAddress: "mailto:gone@example.com" }, a: { calendarAddress: "mailto:ali@example.com", participationStatus: "accepted" } },
      },
      { id: "g2", uid: "gu2", calendarIds: { b: true }, title: "Own reminder", start: "2026-12-02T10:00:00" },
    ]);
    const r = await json(await app.admin("/api/v1/leavers"));
    expect(r.leavers).toEqual([
      {
        address: "gone@example.com",
        name: "Gone Person",
        meetings: [{ id: "g1", title: "Customer review", start: "2026-12-01T10:00:00", timeZone: "Europe/Istanbul", repeats: false, guests: 1 }],
      },
    ]);
    expect(
      (await app.admin("/api/v1/leavers/gone@example.com/handover", { method: "POST", body: JSON.stringify({ to: "nobody@example.com", ids: ["g1"] }) }))
        .status,
    ).toBe(403);
    const done = await json(
      await app.admin("/api/v1/leavers/gone@example.com/handover", { method: "POST", body: JSON.stringify({ to: "jane@example.com", ids: ["g1"] }) }),
    );
    expect(done).toEqual({ done: 1 });
    const jane = app.fake.accountByAddress("jane@example.com")!;
    const copy = app.fake.events.get(jane.id)!.find((e) => e.title === "Customer review")!;
    expect(copy.organizerCalendarAddress).toBe("mailto:jane@example.com");
    expect(copy.uid).not.toBe("gu1");
    expect(Object.values(copy.participants!).map((p) => [p.calendarAddress, p.participationStatus])).toEqual([
      ["mailto:ali@example.com", "needs-action"],
      ["mailto:jane@example.com", "accepted"],
    ]);
    expect(app.fake.events.get(gone.id)!.map((e) => e.id)).toEqual(["g2"]);
    const set = app.fake.calls.filter((c) => c.method === "CalendarEvent/set").at(-1)!;
    expect(set).toMatchObject({ as: "openasy-calendar", args: { sendSchedulingMessages: true, destroy: ["g1"] } });
    expect((await app.admin("/api/v1/leavers/jane@example.com/cancel", { method: "POST", body: JSON.stringify({ ids: [] }) })).status).toBe(404);
  });
});

describe("device passwords", () => {
  it("are made for a person's own account, shown once, and can be removed", async () => {
    const made = await app.jane("/api/v1/devices", { method: "POST", body: JSON.stringify({ name: " iPhone " }) });
    expect(made.status).toBe(201);
    const device = await json(made);
    expect(device).toMatchObject({ description: "iPhone", username: "jane@example.com" });
    const list = await json(await app.jane("/api/v1/devices"));
    expect(list.devices).toEqual([{ id: device.id, description: "iPhone" }]);
    expect(JSON.stringify(list)).not.toContain(device.secret);
    expect((await app.jane(`/api/v1/devices/${device.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.jane(`/api/v1/devices/${device.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.jane("/api/v1/devices", { method: "POST", body: JSON.stringify({ name: "" }) })).status).toBe(422);
  });

  it("says when the mail server does not answer", async () => {
    app.fake.state.down = true;
    try {
      const res = await app.jane("/api/v1/devices");
      expect(res.status).toBe(502);
      expect((await json(res)).code).toBe("mail-server-unavailable");
    } finally {
      app.fake.state.down = false;
    }
  });
});
