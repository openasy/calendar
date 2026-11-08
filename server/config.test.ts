import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, watchConfig } from "./config.ts";

describe("the calendar file", () => {
  it("reads teams and rooms, with what rooms take by default", () => {
    const c = parseConfig(`
teams:
  - { address: Sales-Team@Example.com, name: " Sales team ", members: [jane@example.com] }
rooms:
  - { address: lisbon@rooms.example.com, name: Lisbon, seats: 6, features: [Screen] }
  - { address: projector@rooms.example.com, name: Projector, kind: equipment, bookers: [jane@example.com], bookAhead: 30 }
`);
    expect(c.teams).toEqual([{ address: "sales-team@example.com", name: "Sales team", members: ["jane@example.com"] }]);
    expect(c.rooms[0]).toEqual({
      address: "lisbon@rooms.example.com",
      name: "Lisbon",
      kind: "room",
      seats: 6,
      location: null,
      features: ["Screen"],
      bookers: [],
      bookAhead: 180,
    });
    expect(c.rooms[1]).toMatchObject({ kind: "equipment", seats: null, bookers: ["jane@example.com"], bookAhead: 30 });
  });

  it("is empty when there is nothing in it", () => {
    expect(parseConfig("")).toEqual({ teams: [], rooms: [] });
    expect(parseConfig("# only a comment\n")).toEqual({ teams: [], rooms: [] });
  });

  it("says which entry and field to fix", () => {
    expect(() => parseConfig("teams: [")).toThrow(/Not valid YAML/);
    expect(() => parseConfig("people: []")).toThrow("Unknown people; the file holds teams: and rooms:.");
    expect(() => parseConfig("teams:\n  - { address: a@example.com }")).toThrow("teams[0].name is required: text of up to 128 characters.");
    expect(() => parseConfig("teams:\n  - { address: nope, name: A }")).toThrow("teams[0].address is an email address, such as jane@example.com.");
    expect(() => parseConfig("teams:\n  - { address: a@example.com, name: A, colour: red }")).toThrow(
      "teams[0]: unknown colour; a team takes address, name, members.",
    );
    expect(() => parseConfig("teams:\n  - { address: a@example.com, name: A, members: [b@example.com, B@example.com] }")).toThrow(
      "teams[0].members: b@example.com is in the list twice.",
    );
    expect(() => parseConfig("rooms:\n  - { address: a@example.com, name: A, kind: car }")).toThrow("rooms[0].kind is room or equipment.");
    expect(() => parseConfig("rooms:\n  - { address: a@example.com, name: A, seats: 0 }")).toThrow("rooms[0].seats is a whole number from 1 to 10000.");
    expect(() => parseConfig("rooms:\n  - { address: a@example.com, name: A, bookAhead: 1000 }")).toThrow(
      "rooms[0].bookAhead is a number of days from 1 to 730.",
    );
    expect(() => parseConfig("teams:\n  - { address: a@example.com, name: A }\nrooms:\n  - { address: a@example.com, name: B }")).toThrow(
      "rooms[0]: a@example.com is already teams[0].",
    );
  });

  it("is applied when it changes, and a mistake keeps the last good version", () => {
    const dir = mkdtempSync(join(tmpdir(), "calendar-config-"));
    const path = join(dir, "calendar.yaml");
    const applied: number[] = [];
    try {
      const w = watchConfig(path, (c) => applied.push(c.rooms.length), { everyMs: 60_000 });
      // No file yet is an empty one: Calendar runs without teams and rooms.
      expect(applied).toEqual([0]);
      expect(w.state.error).toBeNull();
      writeFileSync(path, "rooms:\n  - { address: a@rooms.example.com, name: A }\n");
      w.read();
      expect(applied).toEqual([0, 1]);
      expect(w.state.text).toContain("a@rooms.example.com");
      writeFileSync(path, "rooms: [\n");
      w.read();
      expect(applied).toEqual([0, 1]);
      expect(w.state.error).toMatch(/Not valid YAML/);
      expect(w.state.rooms).toBe(1);
      w.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
