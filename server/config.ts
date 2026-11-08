// The team calendars, rooms and equipment Calendar runs, from one YAML file (CALENDAR_CONFIG). As with the install's
// other files, the file is the only way in: no screen or API route adds, changes or removes a team or a room. It is
// applied whole or not at all, read again within a minute of a change, and a file with a mistake leaves the last good
// version in place. People's own calendars need nothing here: every mailbox on the mail server has one.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

export interface Team {
  /** The team's own account on the mail server, which holds its calendars and address book. */
  address: string;
  name: string;
  /** Mailboxes that see and edit the team's calendars and contacts. */
  members: string[];
}

export interface Room {
  /** The address people invite to book it. */
  address: string;
  name: string;
  /** A room has seats; equipment is lent out, such as a projector or a car. */
  kind: "room" | "equipment";
  seats: number | null;
  /** Where it is, such as 3rd floor. */
  location: string | null;
  /** What it has, such as Screen or Video bar. */
  features: string[];
  /** Mailboxes that may book it; everyone when empty. */
  bookers: string[];
  /** How many days ahead it accepts a booking. */
  bookAhead: number;
}

export interface CalendarConfig {
  teams: Team[];
  rooms: Room[];
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;
const TOP_KEYS = ["teams", "rooms"];
const TEAM_KEYS = ["address", "name", "members"];
const ROOM_KEYS = ["address", "name", "kind", "seats", "location", "features", "bookers", "bookAhead"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** An address, lowercased; throws with where it is in the file. */
function address(v: unknown, at: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  const i = s.lastIndexOf("@");
  if (i < 1 || !LOCAL.test(s.slice(0, i)) || !DOMAIN.test(s.slice(i + 1))) throw new Error(`${at} is an email address, such as jane@example.com.`);
  return s;
}

function addresses(v: unknown, at: string, max: number): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new Error(`${at} is a list of up to ${max} addresses.`);
  const out = v.map((x, k) => address(x, `${at}[${k}]`));
  const twice = out.find((a, k) => out.indexOf(a) !== k);
  if (twice) throw new Error(`${at}: ${twice} is in the list twice.`);
  return out;
}

function text(v: unknown, at: string, max: number, required = false): string | null {
  if (v === undefined && !required) return null;
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new Error(`${at} is ${required ? "required: " : ""}text of up to ${max} characters.`);
  return v.trim();
}

/** Reads the file's text. Throws with the entry and field at fault, so one message says what to fix. */
export function parseConfig(source: string): CalendarConfig {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return { teams: [], rooms: [] };
  if (!isObj(doc)) throw new Error("The file holds two lists, teams: and rooms:, and nothing else.");
  const extra = Object.keys(doc).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length) throw new Error(`Unknown ${extra.join(", ")}; the file holds teams: and rooms:.`);

  // Every address of the file is one team or one room.
  const used = new Map<string, string>();
  const claim = (addr: string, at: string) => {
    const was = used.get(addr);
    if (was) throw new Error(`${at}: ${addr} is already ${was}.`);
    used.set(addr, at);
  };

  const teamList = doc.teams ?? [];
  if (!Array.isArray(teamList)) throw new Error("teams must be a list.");
  if (teamList.length > 500) throw new Error("teams holds at most 500 entries.");
  const teams = teamList.map((t: unknown, i): Team => {
    const at = `teams[${i}]`;
    if (!isObj(t)) throw new Error(`${at} must be a map with address, name and members.`);
    const bad = Object.keys(t).filter((k) => !TEAM_KEYS.includes(k));
    if (bad.length) throw new Error(`${at}: unknown ${bad.join(", ")}; a team takes ${TEAM_KEYS.join(", ")}.`);
    const addr = address(t.address, `${at}.address`);
    claim(addr, at);
    return { address: addr, name: text(t.name, `${at}.name`, 128, true)!, members: addresses(t.members, `${at}.members`, 5000) };
  });

  const roomList = doc.rooms ?? [];
  if (!Array.isArray(roomList)) throw new Error("rooms must be a list.");
  if (roomList.length > 1000) throw new Error("rooms holds at most 1000 entries.");
  const rooms = roomList.map((r: unknown, i): Room => {
    const at = `rooms[${i}]`;
    if (!isObj(r)) throw new Error(`${at} must be a map with at least address and name.`);
    const bad = Object.keys(r).filter((k) => !ROOM_KEYS.includes(k));
    if (bad.length) throw new Error(`${at}: unknown ${bad.join(", ")}; a room takes ${ROOM_KEYS.join(", ")}.`);
    const addr = address(r.address, `${at}.address`);
    claim(addr, at);
    if (r.kind !== undefined && r.kind !== "room" && r.kind !== "equipment") throw new Error(`${at}.kind is room or equipment.`);
    if (r.seats !== undefined && (!Number.isInteger(r.seats) || (r.seats as number) < 1 || (r.seats as number) > 10_000))
      throw new Error(`${at}.seats is a whole number from 1 to 10000.`);
    if (r.bookAhead !== undefined && (!Number.isInteger(r.bookAhead) || (r.bookAhead as number) < 1 || (r.bookAhead as number) > 730))
      throw new Error(`${at}.bookAhead is a number of days from 1 to 730.`);
    if (r.features !== undefined && (!Array.isArray(r.features) || r.features.length > 20)) throw new Error(`${at}.features is a list of up to 20 names.`);
    const features = ((r.features ?? []) as unknown[]).map((f, k) => text(f, `${at}.features[${k}]`, 64, true)!);
    return {
      address: addr,
      name: text(r.name, `${at}.name`, 128, true)!,
      kind: (r.kind as Room["kind"] | undefined) ?? "room",
      seats: (r.seats as number | undefined) ?? null,
      location: text(r.location, `${at}.location`, 128),
      features,
      bookers: addresses(r.bookers, `${at}.bookers`, 5000),
      bookAhead: (r.bookAhead as number | undefined) ?? 180,
    };
  });

  return { teams, rooms };
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  teams: number;
  rooms: number;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** The file's text as it was last applied, for the Settings page. */
  text: string | null;
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version to `apply`. A file that cannot be read or parsed leaves the last good one in place. A missing file is an
 * empty one: Calendar works without teams and rooms. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: CalendarConfig) => void,
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, teams: 0, rooms: 0, error: null, text: null };
  let seen = "";
  const read = () => {
    let source: string;
    let stamp: string;
    try {
      const st = statSync(path);
      source = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(source).digest("hex")}`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && seen === "") {
        seen = "missing";
        apply({ teams: [], rooms: [] });
        Object.assign(state, { appliedAt: new Date().toISOString(), teams: 0, rooms: 0, error: null, text: "" });
        onChange?.(state);
        return;
      }
      const error = `Cannot read ${path}: ${code ?? (err as Error).message}`;
      if (state.error !== error && code !== "ENOENT") ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const config = parseConfig(source);
      apply(config);
      Object.assign(state, { appliedAt: new Date().toISOString(), teams: config.teams.length, rooms: config.rooms.length, error: null, text: source });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
