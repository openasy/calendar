// A room books itself: invited to an event, it accepts when it is free at every time of the event, within how far
// ahead it takes bookings and from someone who may book it, and declines otherwise. Calendar answers for each room of
// the file by acting as its account, so the answer goes back to the organizer like any guest's (iTIP, RFC 5546).
import type { DatabaseSync } from "node:sqlite";
import type { Room } from "./config.ts";
import { log } from "./log.ts";
import { CALENDARS, CORE, type Invocation, type Stalwart } from "./stalwart.ts";

const USING = [CORE, CALENDARS];
const DAY = 86_400_000;
/** Stalwart expands recurring events at most this far in one query (maxExpandedQueryDuration, P52W1D). */
const MAX_WINDOW = 364 * DAY;

export interface Span {
  start: number;
  end: number;
}

export interface Booking {
  /** The organizer's address, without mailto:. */
  organizer: string | null;
  /** Its times from now until as far ahead as the room looks. */
  times: Span[];
  /** When it starts, when it lies wholly beyond that window. */
  later: number | null;
}

export type Answer = { answer: "accepted" | "declined"; reason: string };

/** What the room answers. `taken` are the times of what it has accepted already. */
export function decide(room: Room, booking: Booking, taken: Span[], now: number): Answer {
  if (room.bookers.length && (!booking.organizer || !room.bookers.includes(booking.organizer)))
    return { answer: "declined", reason: `${booking.organizer ?? "The organizer"} may not book ${room.name}.` };
  const limit = now + room.bookAhead * DAY;
  if (booking.later !== null || booking.times.some((t) => t.start > limit))
    return { answer: "declined", reason: `${room.name} takes bookings up to ${room.bookAhead} days ahead.` };
  const clash = booking.times.find((t) => taken.some((o) => o.start < t.end && t.start < o.end));
  if (clash) return { answer: "declined", reason: `${room.name} is already booked at that time.` };
  return { answer: "accepted", reason: `${room.name} is free.` };
}

const mailto = (addr: string) => `mailto:${addr}`;
const bare = (uri: unknown) => (typeof uri === "string" ? uri.replace(/^mailto:/i, "").toLowerCase() : null);

interface EventRow {
  id: string;
  uid: string;
  title?: string;
  status?: string;
  participants?: Record<string, { calendarAddress?: string; participationStatus?: string; roles?: Record<string, boolean> }>;
  organizerCalendarAddress?: string;
  utcStart?: string;
  utcEnd?: string;
  recurrenceRule?: unknown;
}

/** The room's own entry among an event's participants. */
function roomKey(e: EventRow, room: Room): string | undefined {
  return Object.entries(e.participants ?? {}).find(([, p]) => bare(p.calendarAddress) === room.address)?.[0];
}

function organizerOf(e: EventRow): string | null {
  return bare(e.organizerCalendarAddress) ?? bare(Object.values(e.participants ?? {}).find((p) => p.roles?.owner || p.roles?.chair)?.calendarAddress) ?? null;
}

const span = (e: { utcStart?: string; utcEnd?: string }): Span | null =>
  e.utcStart && e.utcEnd ? { start: Date.parse(e.utcStart), end: Date.parse(e.utcEnd) } : null;

/** Rooms' event state, so each round reads only what changed since the last. */
export type RoomState = Map<string, string>;

export interface RoomRound {
  answered: number;
  errors: number;
}

/** Answers every invitation each room has not answered yet. */
export async function answerRooms(stalwart: Stalwart, rooms: Room[], state: RoomState, db: DatabaseSync, now = Date.now): Promise<RoomRound> {
  const round: RoomRound = { answered: 0, errors: 0 };
  for (const room of rooms) {
    try {
      round.answered += await answerRoom(stalwart, room, state, db, now());
    } catch (err) {
      round.errors++;
      log("warn", "room could not answer its invitations", { room: room.address, error: (err as Error).message });
    }
  }
  return round;
}

async function answerRoom(stalwart: Stalwart, room: Room, state: RoomState, db: DatabaseSync, now: number): Promise<number> {
  const call = async (methodCalls: Invocation[]) => {
    const r = await stalwart.call(room.address, { using: USING, methodCalls });
    for (const [name, args] of r.methodResponses) if (name === "error") throw new Error(`${String(args.type)}: ${String(args.description ?? "")}`);
    return r.methodResponses;
  };
  const session = await stalwart.session(room.address);
  const accountId = session.primaryAccounts[CALENDARS];
  if (!accountId) return 0;

  // What changed since the last round; everything the first time.
  const since = state.get(room.address);
  let ids: string[];
  let newState: string;
  if (since) {
    const [[name, changes]] = (
      await stalwart.call(room.address, {
        using: USING,
        methodCalls: [["CalendarEvent/changes", { accountId, sinceState: since, maxChanges: 500 }, "0"]],
      })
    ).methodResponses as [Invocation];
    if (name === "error") {
      state.delete(room.address);
      return answerRoom(stalwart, room, state, db, now);
    }
    ids = [...(changes.created as string[]), ...(changes.updated as string[])];
    newState = changes.newState as string;
  } else {
    // The state first: anything that changes while this round reads is read again in the next one.
    const [[, current], [, q]] = (await call([
      ["CalendarEvent/get", { accountId, ids: [] }, "0"],
      ["CalendarEvent/query", { accountId }, "1"],
    ])) as [Invocation, Invocation];
    ids = q.ids as string[];
    newState = current.state as string;
  }
  if (!ids.length) return (state.set(room.address, newState), 0);

  const [[, got]] = (await call([
    ["CalendarEvent/get", { accountId, ids, properties: ["uid", "title", "status", "participants", "organizerCalendarAddress", "recurrenceRule"] }, "0"],
  ])) as [Invocation];
  const open = (got.list as EventRow[]).filter((e) => {
    const key = roomKey(e, room);
    return key && e.status !== "cancelled" && (e.participants![key]!.participationStatus ?? "needs-action") === "needs-action";
  });

  let answered = 0;
  if (open.length) {
    const end = now + Math.min(room.bookAhead * DAY + DAY, MAX_WINDOW);
    // Every time the room is booked from now on, as Stalwart expands the recurring ones.
    const all = await call([
      [
        "CalendarEvent/query",
        { accountId, filter: { after: new Date(now).toISOString().slice(0, 19), before: new Date(end).toISOString().slice(0, 19) }, expandRecurrences: true },
        "0",
      ],
      [
        "CalendarEvent/get",
        {
          accountId,
          "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" },
          properties: ["uid", "status", "participants", "utcStart", "utcEnd"],
        },
        "1",
      ],
    ]);
    const instances = (all[1]![1].list as EventRow[]).filter((i) => i.status !== "cancelled");
    for (const e of open) {
      const times = instances.filter((i) => i.uid === e.uid).flatMap((i) => span(i) ?? []);
      let later: number | null = null;
      if (!times.length) {
        // Nothing from now on within the window: either it is over, or it starts later than the room looks.
        const [[, base]] = (await call([["CalendarEvent/get", { accountId, ids: [e.id], properties: ["utcStart", "utcEnd"] }, "0"]])) as [Invocation];
        const s = span((base.list as EventRow[])[0] ?? {});
        if (!s || s.end <= now) continue;
        later = s.start;
      }
      const taken = instances
        .filter(
          (i) =>
            i.uid !== e.uid &&
            (() => {
              const k = roomKey(i, room);
              return k && i.participants![k]!.participationStatus === "accepted";
            })(),
        )
        .flatMap((i) => span(i) ?? []);
      const a = decide(room, { organizer: organizerOf(e), times, later }, taken, now);
      const key = roomKey(e, room)!;
      await call([
        ["CalendarEvent/set", { accountId, sendSchedulingMessages: true, update: { [e.id]: { [`participants/${key}/participationStatus`]: a.answer } } }, "0"],
      ]);
      db.prepare("INSERT INTO room_answers (at, room, uid, title, organizer, answer, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        new Date(now).toISOString(),
        room.address,
        e.uid,
        e.title ?? null,
        organizerOf(e),
        a.answer,
        a.reason,
      );
      // Accepted times count against the next invitation of this round.
      if (a.answer === "accepted")
        for (const i of instances)
          if (i.uid === e.uid) i.participants![key] = { ...i.participants![key], participationStatus: "accepted", calendarAddress: mailto(room.address) };
      log("info", "room answered an invitation", { room: room.address, uid: e.uid, answer: a.answer, reason: a.reason });
      answered++;
    }
  }
  // The answers themselves show up as changes in the next round, already answered, and are passed over.
  state.set(room.address, newState);
  db.prepare("DELETE FROM room_answers WHERE at < ?").run(new Date(now - 90 * DAY).toISOString());
  return answered;
}
