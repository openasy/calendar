// Events as the pages show and change them. The mail server expands repeating events into their times; a time that
// was moved or changed carries only what changed, so each time is its series with that change laid over it. Changes
// go back as JSCalendar: a whole series, one time of it (an override that carries the whole event, so every calendar
// app shows it in full), or the times from one on (the series ends there and a new one starts). Guests hear of every
// change by email or in their calendar: the mail server sends the invitations and answers (iTIP).
import { checkSet, jmap, type Answer, type Call, type EventData, type EventObj, type Participant } from "./api.ts";
import {
  addDays,
  dateOf,
  formatDuration,
  parseDuration,
  toLocal,
  toUtc,
  type DayCode,
  type Frequency,
  type LocalDateTime,
  type RecurrenceRule,
  type RepeatChoice,
  ruleFor,
} from "./time.ts";

const DAY = 86_400_000;

/** Every property the pages read of an event. */
export const EVENT_PROPERTIES = [
  "id",
  "uid",
  "baseEventId",
  "recurrenceId",
  "calendarIds",
  "title",
  "description",
  "start",
  "timeZone",
  "duration",
  "showWithoutTime",
  "utcStart",
  "utcEnd",
  "status",
  "freeBusyStatus",
  "privacy",
  "locations",
  "participants",
  "organizerCalendarAddress",
  "recurrenceRule",
  "recurrenceOverrides",
  "alerts",
];

/** One time of an event, placed on the calendar. */
export interface Shown {
  /** Unique on the page: the instance's id. */
  key: string;
  accountId: string;
  calendarId: string;
  /** The event to change: the series for a repeating one. */
  base: EventObj;
  /** This time: the series with its own changes laid over. */
  event: EventObj;
  /** The series' local start this time stands for, or null for a single event. */
  recurrenceId: LocalDateTime | null;
  allDay: boolean;
  /** Instants, for timed events; for all-day ones, midnight in the page's zone. */
  start: number;
  end: number;
  /** First and last day, for all-day events (the last is included). */
  firstDay: string;
  lastDay: string;
  /** The signed-in person's entry among the participants, and their answer. */
  myKey: string | null;
  answer: Answer | null;
  /** The signed-in person organizes it, or it has no guests. */
  organizer: boolean;
}

export const mailto = (addr: string) => `mailto:${addr.toLowerCase()}`;
export const bare = (uri: string | null | undefined) => (uri ?? "").replace(/^mailto:/i, "").toLowerCase();

/** The participant that is this address. */
export function participantKey(e: EventData, addr: string): string | null {
  return Object.entries(e.participants ?? {}).find(([, p]) => bare(p.calendarAddress) === addr.toLowerCase())?.[0] ?? null;
}

export function organizerOf(e: EventData): string | null {
  return bare(e.organizerCalendarAddress) || bare(Object.values(e.participants ?? {}).find((p) => p.roles?.owner || p.roles?.chair)?.calendarAddress) || null;
}

/** A time of an event: the series, with the time's own changes. */
function merge(base: EventObj | undefined, instance: EventObj): EventObj {
  if (!base) return instance;
  const own = Object.fromEntries(Object.entries(instance).filter(([, v]) => v !== undefined && v !== null)) as Partial<EventObj>;
  return { ...base, ...own, id: instance.id, recurrenceId: instance.recurrenceId ?? null };
}

/** Where a time goes on the calendar, in the page's zone. */
export function place(e: EventObj, tz: string): Pick<Shown, "allDay" | "start" | "end" | "firstDay" | "lastDay"> {
  const duration = parseDuration(e.duration ?? "PT0S");
  if (e.showWithoutTime) {
    const firstDay = dateOf(e.start);
    const days = Math.max(1, Math.round(duration / DAY));
    const lastDay = addDays(firstDay, days - 1);
    return { allDay: true, start: toUtc(firstDay, tz), end: toUtc(addDays(firstDay, days), tz), firstDay, lastDay };
  }
  // A floating time (no zone) is the same wall-clock time wherever it is read.
  const start = e.utcStart && e.timeZone ? Date.parse(e.utcStart) : toUtc(e.start, e.timeZone || tz);
  const end = start + Math.max(duration, 0);
  return { allDay: false, start, end, firstDay: dateOf(toLocal(start, tz)), lastDay: dateOf(toLocal(Math.max(start, end - 1), tz)) };
}

/** Every time of the events in these calendars between two instants, as the signed-in person sees them. */
export async function loadEvents(
  call: Call,
  accounts: Array<{ accountId: string; calendarIds: string[] }>,
  from: number,
  to: number,
  me: string,
  tz: string,
): Promise<Shown[]> {
  // A day on each side, so all-day and floating events of the edge days are found whatever the zone.
  const after = new Date(from - DAY).toISOString().slice(0, 19);
  const before = new Date(to + DAY).toISOString().slice(0, 19);
  const out: Shown[] = [];
  await Promise.all(
    accounts
      .filter((a) => a.calendarIds.length)
      .map(async ({ accountId, calendarIds }) => {
        const r = await jmap(call, [
          ["CalendarEvent/query", { accountId, filter: { after, before }, expandRecurrences: true }, "q"],
          ["CalendarEvent/get", { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: EVENT_PROPERTIES }, "g"],
        ]);
        const list = (r.g!.list ?? []) as EventObj[];
        const baseIds = [...new Set(list.map((e) => e.baseEventId).filter((x): x is string => !!x))];
        const bases = new Map<string, EventObj>();
        if (baseIds.length) {
          const b = await jmap(call, [["CalendarEvent/get", { accountId, ids: baseIds, properties: EVENT_PROPERTIES }, "b"]]);
          for (const e of (b.b!.list ?? []) as EventObj[]) bases.set(e.id, e);
        }
        for (const instance of list) {
          const base = instance.baseEventId ? bases.get(instance.baseEventId) : undefined;
          const event = merge(base, instance);
          const calendarId = Object.keys(event.calendarIds ?? {}).find((c) => calendarIds.includes(c));
          if (!calendarId || event.status === "cancelled") continue;
          const at = place(event, tz);
          if (at.end <= from || at.start >= to) continue;
          const myKey = participantKey(event, me);
          const organizer = !Object.keys(event.participants ?? {}).length || organizerOf(event) === me.toLowerCase();
          out.push({
            key: `${accountId}/${instance.id}`,
            accountId,
            calendarId,
            base: base ?? instance,
            event,
            recurrenceId: instance.baseEventId ? (instance.recurrenceId ?? null) : null,
            ...at,
            myKey,
            answer: myKey ? (event.participants![myKey]!.participationStatus ?? "needs-action") : null,
            organizer,
          });
        }
      }),
  );
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

// ------------------------------------------------------------------ the form

export interface Guest {
  email: string;
  name: string;
}

export interface EventForm {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  date: string;
  startTime: string;
  /** The last day, for an all-day event; the day it ends, for a timed one. */
  endDate: string;
  endTime: string;
  timeZone: string;
  repeat: RepeatChoice;
  custom: { frequency: Frequency; interval: number; days: DayCode[] };
  ends: "never" | "until" | "count";
  until: string;
  count: number;
  guests: Guest[];
  /** The room or equipment booked, by address; empty for none. */
  room: string;
  /** Before the start, such as -PT15M; empty for no reminder. */
  reminder: string;
  reminderBy: "display" | "email";
  privacy: "public" | "private";
  free: boolean;
  /** accountId/calendarId */
  calendar: string;
}

/** The rule for the form's repeat and end fields. */
export function formRule(f: EventForm): RecurrenceRule | null {
  const rule = ruleFor(f.repeat, f.date, f.custom);
  if (!rule) return null;
  if (f.ends === "count" && f.count > 0) rule.count = f.count;
  if (f.ends === "until" && f.until) rule.until = `${f.until}T23:59:59`;
  return rule;
}

/** The event's times from the form: local start, zone and duration. */
export function formTimes(f: EventForm): Pick<EventData, "start" | "timeZone" | "duration" | "showWithoutTime"> {
  if (f.allDay) {
    const days = Math.max(1, Math.round((Date.parse(`${f.endDate}T00:00:00Z`) - Date.parse(`${f.date}T00:00:00Z`)) / DAY) + 1);
    return { start: `${f.date}T00:00:00`, timeZone: null, duration: `P${days}D`, showWithoutTime: true };
  }
  const start = `${f.date}T${f.startTime}:00`;
  const end = `${f.endDate}T${f.endTime}:00`;
  const ms = Math.max(toUtc(end, f.timeZone) - toUtc(start, f.timeZone), 0);
  return { start, timeZone: f.timeZone, duration: formatDuration(ms), showWithoutTime: false };
}

/**
 * The participants for the form: the organizer, each guest and the room. People already invited keep their answer
 * unless the time changed, when everyone is asked again, as calendar apps do.
 */
export function formParticipants(
  f: EventForm,
  me: { address: string; name: string },
  rooms: Array<{ address: string; name: string; kind: string }>,
  previous: Record<string, Participant> | null | undefined,
  timeChanged: boolean,
): Record<string, Participant> | null {
  const room = rooms.find((r) => r.address === f.room);
  if (!f.guests.length && !room) return null;
  const old = new Map(Object.values(previous ?? {}).map((p) => [bare(p.calendarAddress), p]));
  const keep = (addr: string): Partial<Participant> => {
    const p = old.get(addr);
    return p && !timeChanged && p.participationStatus ? { participationStatus: p.participationStatus } : {};
  };
  const out: Record<string, Participant> = {
    organizer: {
      "@type": "Participant",
      name: me.name,
      calendarAddress: mailto(me.address),
      roles: { owner: true, attendee: true },
      participationStatus: (old.get(me.address)?.participationStatus as Answer | undefined) ?? "accepted",
    },
  };
  f.guests
    .filter((g) => g.email.toLowerCase() !== me.address)
    .forEach((g, i) => {
      out[`g${i + 1}`] = {
        "@type": "Participant",
        ...(g.name ? { name: g.name } : {}),
        calendarAddress: mailto(g.email),
        kind: "individual",
        roles: { attendee: true },
        participationStatus: "needs-action",
        expectReply: true,
        ...keep(g.email.toLowerCase()),
      };
    });
  if (room)
    out.room = {
      "@type": "Participant",
      name: room.name,
      calendarAddress: mailto(room.address),
      kind: room.kind === "equipment" ? "resource" : "location",
      roles: { attendee: true },
      participationStatus: "needs-action",
      expectReply: true,
      ...keep(room.address),
    };
  return out;
}

/** Everything of an event the form sets, as JSCalendar. */
export function formToEvent(
  f: EventForm,
  me: { address: string; name: string },
  rooms: Array<{ address: string; name: string; kind: string }>,
  previous?: EventData,
): EventData {
  const times = formTimes(f);
  const timeChanged =
    !!previous && (previous.start !== times.start || previous.duration !== times.duration || (previous.timeZone ?? null) !== (times.timeZone ?? null));
  const participants = formParticipants(f, me, rooms, previous?.participants, timeChanged);
  const room = rooms.find((r) => r.address === f.room);
  const locations: EventData["locations"] = {};
  if (room) locations.room = { "@type": "Location", name: room.name };
  if (f.location.trim()) locations.place = { "@type": "Location", name: f.location.trim() };
  return {
    "@type": "Event",
    title: f.title.trim(),
    description: f.description,
    ...times,
    recurrenceRule: formRule(f),
    participants,
    organizerCalendarAddress: participants ? mailto(me.address) : null,
    locations: Object.keys(locations).length ? locations : null,
    alerts: f.reminder
      ? { r: { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: f.reminder, relativeTo: "start" }, action: f.reminderBy } }
      : null,
    privacy: f.privacy,
    freeBusyStatus: f.free ? "free" : "busy",
  };
}

/** What a change to one time of a series carries: the whole event, never a rule. */
function asOverride(e: EventData): Partial<EventData> {
  const { recurrenceRule: _r, recurrenceOverrides: _o, uid: _u, calendarIds: _c, ...rest } = e as EventObj;
  for (const k of ["id", "baseEventId", "recurrenceId", "utcStart", "utcEnd", "isDraft", "isOrigin", "updated", "created", "sequence"])
    delete (rest as Record<string, unknown>)[k];
  return rest;
}

const hasGuests = (e: EventData) => Object.keys(e.participants ?? {}).length > 1;

export type Scope = "this" | "following" | "all";

/** Creates an event in a calendar; guests and the room get their invitation from the mail server. */
export async function createEvent(call: Call, accountId: string, calendarId: string, data: EventData): Promise<string> {
  const r = await jmap(call, [
    ["CalendarEvent/set", { accountId, sendSchedulingMessages: hasGuests(data), create: { e: { ...data, calendarIds: { [calendarId]: true } } } }, "s"],
  ]);
  checkSet(r.s);
  return (r.s!.created as Record<string, { id: string }>).e!.id;
}

/** Saves a change: to a single event, or to one time, the times from it on, or every time of a series. */
export async function updateEvent(call: Call, shown: Shown, data: EventData, scope: Scope, target?: { accountId: string; calendarId: string }) {
  const { accountId, base } = shown;
  const send = hasGuests(data) || hasGuests(base);
  const moved = target && (target.accountId !== accountId || target.calendarId !== shown.calendarId);
  if (!shown.recurrenceId || scope === "all") {
    const patch: Record<string, unknown> = { ...data };
    if (shown.recurrenceId) {
      // A change to every time keeps the times that were taken out, and the series' first day.
      const shift = toUtc(data.start, data.timeZone || "UTC") - toUtc(shown.event.start, shown.event.timeZone || "UTC");
      patch.start = toLocal(toUtc(base.start, data.timeZone || "UTC") + shift, data.timeZone || "UTC");
      patch.recurrenceRule = data.recurrenceRule ?? null;
      patch.recurrenceOverrides = Object.fromEntries(Object.entries(base.recurrenceOverrides ?? {}).filter(([, o]) => o.excluded)) || null;
    }
    if (moved && target.accountId === accountId) patch.calendarIds = { [target.calendarId]: true };
    if (moved && target.accountId !== accountId) {
      await deleteEvent(call, shown, "all");
      return createEvent(call, target.accountId, target.calendarId, {
        ...base,
        ...data,
        recurrenceRule: patch.recurrenceRule as RecurrenceRule | null,
        start: patch.start as string,
      } as EventData);
    }
    const r = await jmap(call, [["CalendarEvent/set", { accountId, sendSchedulingMessages: send, update: { [base.id]: patch } }, "s"]]);
    return checkSet(r.s);
  }
  if (scope === "this") {
    const r = await jmap(call, [
      [
        "CalendarEvent/set",
        {
          accountId,
          sendSchedulingMessages: send,
          update: { [base.id]: { [`recurrenceOverrides/${shown.recurrenceId}`]: asOverride({ ...shown.event, ...data }) } },
        },
        "s",
      ],
    ]);
    return checkSet(r.s);
  }
  // The times from this one on: the series ends the moment before, and a new one starts with the change.
  await endSeriesBefore(call, shown, send);
  const { uid: _uid, ...rest } = { ...base, ...data } as EventObj;
  const fresh = asOverride(rest) as EventData;
  return createEvent(call, target?.accountId ?? accountId, target?.calendarId ?? shown.calendarId, {
    ...fresh,
    recurrenceRule: data.recurrenceRule ? { ...data.recurrenceRule, count: undefined } : null,
  });
}

async function endSeriesBefore(call: Call, shown: Shown, send: boolean) {
  const { accountId, base, recurrenceId } = shown;
  const until = toLocal(toUtc(recurrenceId!, base.timeZone || "UTC") - 1000, base.timeZone || "UTC");
  const rule = { ...base.recurrenceRule!, until, count: undefined };
  delete rule.count;
  const overrides = Object.fromEntries(Object.entries(base.recurrenceOverrides ?? {}).filter(([id]) => id < recurrenceId!));
  const r = await jmap(call, [
    [
      "CalendarEvent/set",
      {
        accountId,
        sendSchedulingMessages: send,
        update: { [base.id]: { recurrenceRule: rule, recurrenceOverrides: Object.keys(overrides).length ? overrides : null } },
      },
      "s",
    ],
  ]);
  checkSet(r.s);
}

/** Deletes an event, one time of it, or the times from it on; the guests are told. */
export async function deleteEvent(call: Call, shown: Shown, scope: Scope) {
  const { accountId, base } = shown;
  const send = hasGuests(base) && shown.organizer;
  if (!shown.recurrenceId || scope === "all") {
    const r = await jmap(call, [["CalendarEvent/set", { accountId, sendSchedulingMessages: send, destroy: [base.id] }, "s"]]);
    return checkSet(r.s);
  }
  if (scope === "this") {
    const r = await jmap(call, [
      [
        "CalendarEvent/set",
        { accountId, sendSchedulingMessages: send, update: { [base.id]: { [`recurrenceOverrides/${shown.recurrenceId}`]: { excluded: true } } } },
        "s",
      ],
    ]);
    return checkSet(r.s);
  }
  return endSeriesBefore(call, shown, send);
}

/** The signed-in person's answer to an invitation, for the whole series; the organizer gets it by email or in their calendar. */
export async function answerEvent(call: Call, shown: Shown, answer: Exclude<Answer, "needs-action" | "delegated">) {
  if (!shown.myKey) return;
  const r = await jmap(call, [
    [
      "CalendarEvent/set",
      {
        accountId: shown.accountId,
        sendSchedulingMessages: true,
        update: { [shown.base.id]: { [`participants/${shown.myKey}/participationStatus`]: answer } },
      },
      "s",
    ],
  ]);
  checkSet(r.s);
}

/** The form filled in from an event, to change it. */
export function eventToForm(shown: Shown, tz: string, rooms: Array<{ address: string }>, me: string): EventForm {
  const e = shown.event;
  const zone = e.timeZone || tz;
  const startMs = shown.allDay ? 0 : toUtc(e.start, zone);
  const endLocal = shown.allDay ? `${shown.lastDay}T00:00:00` : toLocal(startMs + parseDuration(e.duration), zone);
  const participants = Object.values(e.participants ?? {});
  const room = participants.find((p) => rooms.some((r) => r.address === bare(p.calendarAddress)));
  const rule = shown.base.recurrenceRule ?? null;
  const alert = Object.values(e.alerts ?? {})[0];
  return {
    title: e.title ?? "",
    description: e.description ?? "",
    location: Object.values(e.locations ?? {}).find((l) => !room || l.name !== room.name)?.name ?? "",
    allDay: shown.allDay,
    date: dateOf(e.start),
    startTime: e.start.slice(11, 16),
    endDate: dateOf(endLocal),
    endTime: endLocal.slice(11, 16),
    timeZone: zone,
    repeat: "none",
    custom: {
      frequency: rule?.frequency ?? "weekly",
      interval: rule?.interval ?? 1,
      days: (rule?.byDay ?? []).filter((d) => !d.nthOfPeriod).map((d) => d.day),
    },
    ends: rule?.until ? "until" : rule?.count ? "count" : "never",
    until: rule?.until ? dateOf(rule.until) : "",
    count: rule?.count ?? 10,
    guests: participants
      .filter((p) => p !== room && bare(p.calendarAddress) !== me.toLowerCase() && p.calendarAddress)
      .map((p) => ({ email: bare(p.calendarAddress), name: p.name ?? "" })),
    room: room ? bare(room.calendarAddress) : "",
    reminder: alert?.trigger.offset ?? "",
    reminderBy: alert?.action === "email" ? "email" : "display",
    privacy: e.privacy === "private" || e.privacy === "secret" ? "private" : "public",
    free: e.freeBusyStatus === "free",
    calendar: `${shown.accountId}/${shown.calendarId}`,
  };
}

/** The first free stretch of `minutes` on a day between two hours, given everyone's busy times. */
export function firstFree(
  busy: Array<{ start: number; end: number }>,
  dayStart: number,
  fromHour: number,
  toHour: number,
  minutes: number,
  step = 15,
): number | null {
  const len = minutes * 60_000;
  for (let t = dayStart + fromHour * 3_600_000; t + len <= dayStart + toHour * 3_600_000; t += step * 60_000)
    if (!busy.some((b) => b.start < t + len && t < b.end)) return t;
  return null;
}
