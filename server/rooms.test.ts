import { describe, expect, it } from "vitest";
import type { Room } from "./config.ts";
import { decide } from "./rooms.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-11-04T08:00:00Z");
const room: Room = { address: "lisbon@rooms.example.com", name: "Lisbon", kind: "room", seats: 6, location: null, features: [], bookers: [], bookAhead: 90 };
const at = (h: number, len = 1) => ({ start: now + h * 3_600_000, end: now + (h + len) * 3_600_000 });

describe("a room answers on its own", () => {
  it("accepts when it is free at every time", () => {
    expect(decide(room, { organizer: "jane@example.com", times: [at(2), at(26)], later: null }, [at(4)], now)).toEqual({
      answer: "accepted",
      reason: "Lisbon is free.",
    });
  });

  it("declines a time it is already booked, even one of a series", () => {
    const a = decide(room, { organizer: "jane@example.com", times: [at(2), at(26)], later: null }, [at(26.5)], now);
    expect(a.answer).toBe("declined");
    expect(a.reason).toBe("Lisbon is already booked at that time.");
  });

  it("does not count times that only touch", () => {
    expect(decide(room, { organizer: null, times: [at(2)], later: null }, [at(1), at(3)], now).answer).toBe("accepted");
  });

  it("declines bookings further ahead than it takes them", () => {
    expect(decide(room, { organizer: null, times: [], later: now + 100 * DAY }, [], now)).toEqual({
      answer: "declined",
      reason: "Lisbon takes bookings up to 90 days ahead.",
    });
    expect(decide(room, { organizer: null, times: [at(24 * 91)], later: null }, [], now).answer).toBe("declined");
  });

  it("declines who may not book it", () => {
    const managers = { ...room, bookers: ["mark@example.com"] };
    expect(decide(managers, { organizer: "jane@example.com", times: [at(2)], later: null }, [], now)).toEqual({
      answer: "declined",
      reason: "jane@example.com may not book Lisbon.",
    });
    expect(decide(managers, { organizer: "mark@example.com", times: [at(2)], later: null }, [], now).answer).toBe("accepted");
  });
});
