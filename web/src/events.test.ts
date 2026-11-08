import { describe, expect, it } from "vitest";
import type { EventObj } from "./api.ts";
import { firstFree, formRule, formToEvent, place, type EventForm } from "./events.ts";

const me = { address: "jane@example.com", name: "Jane Doe" };
const rooms = [{ address: "lisbon@rooms.example.com", name: "Lisbon", kind: "room" }];
const form = (f: Partial<EventForm> = {}): EventForm => ({
  title: "Demo",
  description: "",
  location: "",
  allDay: false,
  date: "2026-11-05",
  startTime: "14:00",
  endDate: "2026-11-05",
  endTime: "15:30",
  timeZone: "Europe/Istanbul",
  repeat: "none",
  custom: { frequency: "weekly", interval: 1, days: ["th"] },
  ends: "never",
  until: "",
  count: 10,
  guests: [],
  room: "",
  reminder: "-PT10M",
  reminderBy: "display",
  privacy: "public",
  free: false,
  calendar: "a/b",
  ...f,
});

describe("an event from the form", () => {
  it("has its zone, duration, reminder and no participants when nobody is invited", () => {
    const e = formToEvent(form(), me, rooms);
    expect(e).toMatchObject({
      title: "Demo",
      start: "2026-11-05T14:00:00",
      timeZone: "Europe/Istanbul",
      duration: "PT1H30M",
      showWithoutTime: false,
      participants: null,
      organizerCalendarAddress: null,
    });
    expect(e.alerts).toEqual({ r: { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: "-PT10M", relativeTo: "start" }, action: "display" } });
  });

  it("invites guests and the room, with Jane as the organizer", () => {
    const e = formToEvent(form({ guests: [{ email: "Ali@Example.com", name: "Ali" }], room: "lisbon@rooms.example.com" }), me, rooms);
    expect(e.organizerCalendarAddress).toBe("mailto:jane@example.com");
    expect(Object.values(e.participants!).map((p) => [p.calendarAddress, p.kind ?? null, p.participationStatus])).toEqual([
      ["mailto:jane@example.com", null, "accepted"],
      ["mailto:ali@example.com", "individual", "needs-action"],
      ["mailto:lisbon@rooms.example.com", "location", "needs-action"],
    ]);
    expect(e.locations).toEqual({ room: { "@type": "Location", name: "Lisbon" } });
  });

  it("keeps the guests' answers unless the time changes", () => {
    const first = formToEvent(form({ guests: [{ email: "ali@example.com", name: "" }] }), me, rooms);
    first.participants!.g1!.participationStatus = "accepted";
    const renamed = formToEvent(form({ title: "Demo for Northwind", guests: [{ email: "ali@example.com", name: "" }] }), me, rooms, first);
    expect(renamed.participants!.g1!.participationStatus).toBe("accepted");
    const moved = formToEvent(form({ startTime: "16:00", endTime: "17:00", guests: [{ email: "ali@example.com", name: "" }] }), me, rooms, first);
    expect(moved.participants!.g1!.participationStatus).toBe("needs-action");
  });

  it("is all day without a zone, its last day included", () => {
    expect(formToEvent(form({ allDay: true, date: "2026-11-20", endDate: "2026-11-21" }), me, rooms)).toMatchObject({
      start: "2026-11-20T00:00:00",
      timeZone: null,
      duration: "P2D",
      showWithoutTime: true,
    });
  });

  it("repeats until a day or a number of times", () => {
    expect(formRule(form({ repeat: "weekly", ends: "until", until: "2027-01-31" }))).toMatchObject({ frequency: "weekly", until: "2027-01-31T23:59:59" });
    expect(formRule(form({ repeat: "daily", ends: "count", count: 5 }))).toMatchObject({ frequency: "daily", count: 5 });
  });
});

describe("placing events", () => {
  it("puts a timed event at its instant, whatever zone the page is in", () => {
    const e = { id: "x", start: "2026-11-05T14:00:00", timeZone: "Europe/Istanbul", duration: "PT1H", utcStart: "2026-11-05T11:00:00Z" } as EventObj;
    const p = place(e, "America/New_York");
    expect(new Date(p.start).toISOString()).toBe("2026-11-05T11:00:00.000Z");
    expect(p.end - p.start).toBe(3_600_000);
    expect(p.firstDay).toBe("2026-11-05");
  });

  it("keeps all-day events on their days in any zone", () => {
    const p = place({ id: "x", start: "2026-11-20T00:00:00", duration: "P2D", showWithoutTime: true } as EventObj, "Asia/Tokyo");
    expect([p.allDay, p.firstDay, p.lastDay]).toEqual([true, "2026-11-20", "2026-11-21"]);
  });
});

describe("finding a time", () => {
  it("gives the first stretch everyone is free", () => {
    const day = Date.parse("2026-11-05T00:00:00Z");
    const h = (n: number) => day + n * 3_600_000;
    expect(
      firstFree(
        [
          { start: h(8), end: h(10) },
          { start: h(10.5), end: h(12) },
        ],
        day,
        8,
        18,
        60,
      ),
    ).toBe(h(12));
    expect(firstFree([{ start: h(8), end: h(10) }], day, 8, 18, 30)).toBe(h(10));
    expect(firstFree([{ start: h(8), end: h(18) }], day, 8, 18, 30)).toBeNull();
  });
});
