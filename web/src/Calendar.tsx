import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  IconButton,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  useLocalePreference,
  type Tone,
} from "@openasy/ui";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Globe, MapPin, Pencil, Plus, Repeat, Trash2, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  checkSet,
  jmap,
  type Answer,
  type Availability,
  type Call,
  type CalendarObj,
  type CalendarSession,
  type DirectoryList,
  type SessionAccount,
} from "./api.ts";
import { EventDialog, type DialogStart } from "./EventDialog.tsx";
import { answerEvent, bare, deleteEvent, loadEvents, organizerOf, type Scope, type Shown } from "./events.ts";
import { useT, type T } from "./i18n.ts";
import {
  addDays,
  addMonths,
  browserZone,
  dateOf,
  dayLabel,
  daysBetween,
  describeRule,
  hhmm,
  isoWeek,
  monthStart,
  parseDuration,
  timeZones,
  toLocal,
  toUtc,
  weekdayNames,
  weekStart,
  zoned,
  type RuleWords,
} from "./time.ts";

type View = "day" | "week" | "month" | "agenda";
const HOUR_PX = 44;
const PALETTE = [
  "var(--oa-chart-1)",
  "var(--oa-chart-2)",
  "var(--oa-chart-3)",
  "var(--oa-chart-4)",
  "var(--oa-success)",
  "var(--oa-warning)",
  "var(--oa-danger)",
  "var(--oa-accent)",
];

/** A calendar on the page, with the account it is in and the colour it is drawn in. */
export interface CalendarEntry {
  key: string;
  account: SessionAccount;
  calendar: CalendarObj;
  hue: string;
  /** How the person names it: their own default one by their name. */
  label: string;
}

const hueStyle = (hue: string) => ({ "--cal-hue": hue }) as CSSProperties;

function remember<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`openasy-calendar-${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(`openasy-calendar-${key}`, JSON.stringify(value));
  } catch {
    // A private window keeps nothing; the page works the same.
  }
}

/** The page's time zone, kept per browser. */
export function useTimeZone(): [string, (tz: string) => void] {
  const [tz, setTz] = useState<string>(() => remember("tz", browserZone()));
  return [tz, (z) => (keep("tz", z), setTz(z))];
}

/** Every calendar of the session's accounts, coloured in a fixed order. */
export async function loadCalendars(call: Call, session: CalendarSession, t: T): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  await Promise.all(
    session.accounts.map(async (account) => {
      try {
        const r = await jmap(call, [["Calendar/get", { accountId: account.id }, "c"]]);
        for (const calendar of (r.c!.list ?? []) as CalendarObj[]) {
          const label =
            account.kind === "own" && calendar.isDefault
              ? (session.name ?? session.address)
              : account.kind === "team" && calendar.isDefault
                ? account.name
                : calendar.name.startsWith("Stalwart Calendar")
                  ? account.name
                  : calendar.name;
          out.push({
            key: `${account.id}/${calendar.id}`,
            account,
            calendar,
            hue: "",
            label: account.kind === "shared" && !calendar.isDefault ? `${label} (${account.name})` : label,
          });
        }
      } catch {
        // An account that cannot be read is left out; the others show.
      }
    }),
  );
  const order = ["own", "team", "shared"];
  out.sort(
    (a, b) =>
      order.indexOf(a.account.kind) - order.indexOf(b.account.kind) ||
      Number(b.calendar.isDefault) - Number(a.calendar.isDefault) ||
      a.label.localeCompare(b.label),
  );
  out.forEach((c, i) => (c.hue = c.calendar.color && /^#[0-9a-f]{3,8}$/i.test(c.calendar.color) ? c.calendar.color : PALETTE[i % PALETTE.length]!));
  if (!out.length) throw new Error(t("calendar.noCalendars"));
  return out;
}

export function ruleWords(t: T): RuleWords {
  return {
    every: (unit, interval) => t(`repeat.every.${unit}`, { count: interval }),
    weekdays: t("repeat.everyWeekday"),
    onDays: (days) => t("repeat.onDays", { days }),
    onMonthDay: (day) => t("repeat.onMonthDay", { day }),
    onNth: (nth, day) => t("repeat.onNth", { nth: nth === -1 ? t("repeat.last") : t(`repeat.nth.${Math.min(nth, 5)}` as "repeat.nth.1"), day }),
    times: (count) => t("repeat.times", { count }),
    until: (date) => t("repeat.until", { date }),
  };
}

const ANSWER_TONE: Record<Answer, Tone> = { accepted: "success", tentative: "warning", declined: "danger", "needs-action": "neutral", delegated: "neutral" };

/** Lays overlapping events side by side: each gets a lane and the number of lanes of its group. */
function lanes(items: Array<{ start: number; end: number }>): Array<{ lane: number; of: number }> {
  const out: Array<{ lane: number; of: number }> = items.map(() => ({ lane: 0, of: 1 }));
  let group: number[] = [];
  let groupEnd = -Infinity;
  const ends: number[] = [];
  const close = () => {
    const of = Math.max(1, ...group.map((i) => out[i]!.lane + 1));
    for (const i of group) out[i]!.of = of;
    group = [];
    ends.length = 0;
  };
  items.forEach((e, i) => {
    if (e.start >= groupEnd) (close(), (groupEnd = -Infinity));
    let lane = ends.findIndex((end) => end <= e.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = e.end;
    out[i]!.lane = lane;
    group.push(i);
    groupEnd = Math.max(groupEnd, e.end);
  });
  close();
  return out;
}

// ---------------------------------------------------------------- mini month

function MiniMonth({
  date,
  today,
  shownFrom,
  shownTo,
  onPick,
  locale,
  t,
}: {
  date: string;
  today: string;
  shownFrom: string;
  shownTo: string;
  onPick: (d: string) => void;
  locale: string;
  t: T;
}) {
  const [month, setMonth] = useState(monthStart(date));
  useEffect(() => setMonth(monthStart(date)), [date]);
  const first = weekStart(month);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-fg">{dayLabel(month, locale, { month: "long", year: "numeric" })}</span>
        <span className="flex">
          <IconButton label={t("calendar.prevMonth")} size="xs" variant="ghost" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft className="size-3.5" />
          </IconButton>
          <IconButton label={t("calendar.nextMonth")} size="xs" variant="ghost" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <div className="cal-mini" aria-hidden>
        {weekdayNames(locale, "narrow").map((d, i) => (
          <span key={i} className="cal-mini-head">
            {d}
          </span>
        ))}
      </div>
      <div className="cal-mini">
        {cells.map((d) => {
          const cls = [
            "cal-mini-day",
            d.slice(0, 7) !== month.slice(0, 7) && "cal-mini-other",
            d >= shownFrom && d < shownTo && "cal-mini-shown",
            d === today && "cal-mini-today",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={d}
              type="button"
              className={cls}
              aria-current={d === today ? "date" : undefined}
              aria-label={dayLabel(d, locale, { weekday: "long", day: "numeric", month: "long" })}
              onClick={() => onPick(d)}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- views

interface ViewProps {
  days: string[];
  events: Shown[];
  hueOf: (s: Shown) => string;
  tz: string;
  today: string;
  now: number;
  active: string | null;
  onOpen: (s: Shown) => void;
  onSlot: (date: string, minutes: number) => void;
  busy: Array<{ who: string; name: string; hue: string; spans: Array<{ start: number; end: number }> }>;
  locale: string;
  t: T;
}

function eventName(s: Shown, t: T) {
  return s.event.title?.trim() || t("event.untitled");
}

function TimeGrid({ days, events, hueOf, tz, today, now, active, onOpen, onSlot, busy, locale, t }: ViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX;
  }, [days.length]);
  const allDay = events.filter((e) => e.allDay || e.end - e.start >= 86_400_000);
  const timed = events.filter((e) => !allDay.includes(e));
  const first = days[0]!;
  const last = days.at(-1)!;
  // All-day rows: each event gets the first row free over its days.
  const rows: string[][] = [];
  const placed = allDay
    .filter((e) => e.lastDay >= first && e.firstDay <= last)
    .map((e) => {
      const from = Math.max(0, daysBetween(first, e.firstDay));
      const to = Math.min(days.length - 1, daysBetween(first, e.lastDay));
      let row = rows.findIndex((r) => days.slice(from, to + 1).every((d) => !r.includes(d)));
      if (row < 0) row = rows.push([]) - 1;
      rows[row]!.push(...days.slice(from, to + 1));
      return { e, from, to, row };
    });
  const cols = { "--cal-cols": days.length, "--cal-hour": `${HOUR_PX}px` } as CSSProperties;
  const one = days.length === 1;
  return (
    <div className="cal-scroll">
      <div className={`cal-days ${one ? "cal-days-one" : ""} border-b border-line`} style={cols}>
        <span />
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className={`cal-dayhead ${d === today ? "cal-today" : ""}`}
            onClick={() => onSlot(d, -1)}
            title={t("calendar.newOn", { day: dayLabel(d, locale) })}
          >
            {dayLabel(d, locale, { weekday: "short" })}
            <strong>{Number(d.slice(8))}</strong>
          </button>
        ))}
      </div>
      <div className={`cal-days ${one ? "cal-days-one" : ""} cal-allday`} style={cols} role="group" aria-label={t("calendar.allDay")}>
        <span className="cal-allday-label" style={{ gridRow: `1 / span ${Math.max(rows.length, 1)}` }}>
          {t("calendar.allDay")}
        </span>
        {placed.map(({ e, from, to, row }) => (
          <button
            key={e.key}
            type="button"
            className="cal-chip"
            style={{ ...hueStyle(hueOf(e)), gridColumn: `${from + 2} / ${to + 3}`, gridRow: row + 1 }}
            onClick={() => onOpen(e)}
            aria-pressed={active === e.key}
          >
            {eventName(e, t)}
          </button>
        ))}
      </div>
      <div ref={scroller} style={{ maxHeight: "40rem", overflowY: "auto" }}>
        <div className={`cal-days ${one ? "cal-days-one" : ""}`} style={cols}>
          <div className="cal-hours" style={{ height: 24 * HOUR_PX }}>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span key={h} className="cal-hour" style={{ top: h * HOUR_PX }}>
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {days.map((d) => {
            const dayStart = toUtc(d, tz);
            const dayEnd = toUtc(addDays(d, 1), tz);
            const mine = timed.filter((e) => e.start < dayEnd && e.end > dayStart);
            const layout = lanes(mine.map((e) => ({ start: Math.max(e.start, dayStart), end: Math.min(Math.max(e.end, e.start + 15 * 60_000), dayEnd) })));
            const px = (ms: number) => ((ms - dayStart) / 3_600_000) * HOUR_PX;
            return (
              <div
                key={d}
                role="list"
                aria-label={dayLabel(d, locale)}
                className={`cal-column ${d === today ? "cal-column-today" : ""}`}
                style={{ height: 24 * HOUR_PX }}
              >
                {/* A click on a free time plans an event there; the New event button does the same from the keyboard. */}
                <button
                  type="button"
                  tabIndex={-1}
                  className="cal-slot"
                  aria-label={t("calendar.newOn", { day: dayLabel(d, locale) })}
                  onClick={(ev) => onSlot(d, Math.floor((ev.nativeEvent.offsetY / HOUR_PX) * 2) * 30)}
                />
                {busy.flatMap((b) =>
                  b.spans
                    .filter((s) => s.start < dayEnd && s.end > dayStart)
                    .map((s) => (
                      <span
                        key={`${b.who}-${s.start}`}
                        className="cal-busy"
                        title={t("calendar.busyAt", { name: b.name, from: hhmm(s.start, tz), to: hhmm(s.end, tz) })}
                        style={{
                          ...hueStyle(b.hue),
                          top: px(Math.max(s.start, dayStart)),
                          height: Math.max(px(Math.min(s.end, dayEnd)) - px(Math.max(s.start, dayStart)) - 2, 4),
                        }}
                      />
                    )),
                )}
                {mine.map((e, i) => {
                  const { lane, of } = layout[i]!;
                  const top = px(Math.max(e.start, dayStart));
                  const height = Math.max(px(Math.min(e.end, dayEnd)) - top - 2, 18);
                  const short = height < 30;
                  const cls = [
                    "cal-event",
                    short && "cal-event-short",
                    e.answer === "needs-action" && !e.organizer && "cal-event-pending",
                    e.answer === "tentative" && "cal-event-maybe",
                    active === e.key && "cal-event-active",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const room = Object.values(e.event.locations ?? {})[0]?.name;
                  return (
                    <div key={e.key} role="listitem">
                      <button
                        type="button"
                        className={cls}
                        aria-pressed={active === e.key}
                        onClick={() => onOpen(e)}
                        style={{ ...hueStyle(hueOf(e)), top, height, insetInlineStart: `calc(${(lane / of) * 100}% + 2px)`, width: `calc(${100 / of}% - 4px)` }}
                      >
                        <span className="truncate font-semibold">{eventName(e, t)}</span>
                        {!short && (
                          <span aria-hidden className="truncate text-fg-muted">
                            {hhmm(e.start, tz)}
                            {room && ` · ${room}`}
                          </span>
                        )}
                        <span className="sr-only">
                          , {hhmm(e.start, tz)} {t("calendar.to")} {hhmm(e.end, tz)}
                          {room && `, ${room}`}
                          {e.answer === "needs-action" && !e.organizer && `, ${t("calendar.notAnswered")}`}
                        </span>
                      </button>
                    </div>
                  );
                })}
                {d === today && now >= dayStart && now < dayEnd && <span aria-hidden className="cal-now" style={{ top: px(now) }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ days, month, events, hueOf, tz, today, active, onOpen, onSlot, locale, t }: ViewProps & { month: string }) {
  return (
    <div className="cal-scroll">
      <div className="cal-month" style={{ minWidth: "42rem" }}>
        {weekdayNames(locale).map((d) => (
          <span key={d} className="cal-month-head">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const list = events.filter((e) => e.firstDay <= d && e.lastDay >= d);
          const more = list.length - 3;
          return (
            <div
              key={d}
              role="list"
              aria-label={dayLabel(d, locale)}
              className={`cal-month-day ${d.slice(0, 7) !== month.slice(0, 7) ? "cal-month-other" : ""}`}
            >
              <button
                type="button"
                className={`cal-month-num ${d === today ? "cal-month-num-today" : ""}`}
                onClick={() => onSlot(d, -2)}
                aria-label={dayLabel(d, locale, { weekday: "long", day: "numeric", month: "long" })}
              >
                {Number(d.slice(8))}
              </button>
              {list.slice(0, 3).map((e) => (
                <div key={e.key} role="listitem">
                  <button type="button" className="cal-chip" style={hueStyle(hueOf(e))} onClick={() => onOpen(e)} aria-pressed={active === e.key}>
                    {!e.allDay && e.firstDay === d && <span className="text-fg-muted tabular-nums">{hhmm(e.start, tz)} </span>}
                    {eventName(e, t)}
                  </button>
                </div>
              ))}
              {more > 0 && (
                <button type="button" className="cal-more" onClick={() => onSlot(d, -2)}>
                  {t("calendar.more", { count: more })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Agenda({ days, events, hueOf, tz, onOpen, locale, t }: ViewProps) {
  const withEvents = days.map((d) => ({ d, list: events.filter((e) => e.firstDay <= d && e.lastDay >= d) })).filter((x) => x.list.length);
  if (!withEvents.length) return <p className="m-0 p-4 text-sm text-fg-muted">{t("calendar.nothingPlanned")}</p>;
  return (
    <ul className="cal-list" aria-label={t("view.agenda")}>
      {withEvents.map(({ d, list }) => (
        <li key={d} className="cal-agenda-day">
          <span className="text-sm font-medium text-fg">{dayLabel(d, locale, { weekday: "short", day: "numeric", month: "short" })}</span>
          <ul className="cal-list flex flex-col gap-0.5" aria-label={dayLabel(d, locale)}>
            {list.map((e) => (
              <li key={e.key}>
                <button type="button" className="cal-agenda-row" onClick={() => onOpen(e)}>
                  <span className="text-xs text-fg-muted tabular-nums">
                    {e.allDay ? t("calendar.allDay") : `${hhmm(e.start, tz)} ${t("calendar.to")} ${hhmm(e.end, tz)}`}
                  </span>
                  <span className="cal-dot" style={hueStyle(hueOf(e))} />
                  <span className="truncate text-sm">
                    {eventName(e, t)}
                    {e.answer === "needs-action" && !e.organizer && <span className="text-xs text-fg-muted"> · {t("calendar.notAnswered")}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- the open event

function EventDetail({
  s,
  entry,
  tz,
  me,
  directory,
  onAnswer,
  onEdit,
  onDelete,
  onClose,
  locale,
  t,
}: {
  s: Shown;
  entry: CalendarEntry | undefined;
  tz: string;
  me: string;
  directory: DirectoryList;
  onAnswer: (a: "accepted" | "tentative" | "declined") => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  locale: string;
  t: T;
}) {
  const e = s.event;
  const people = new Map(directory.people.map((p) => [p.address, p.name]));
  const rooms = new Map(directory.rooms.map((r) => [r.address, r]));
  const guests = Object.entries(e.participants ?? {}).filter(([, p]) => !rooms.has(bare(p.calendarAddress)));
  const room = Object.values(e.participants ?? {}).find((p) => rooms.has(bare(p.calendarAddress)));
  const going = guests.filter(([, p]) => p.participationStatus === "accepted").length;
  const organizer = organizerOf(e);
  const when = s.allDay
    ? s.firstDay === s.lastDay
      ? dayLabel(s.firstDay, locale, { weekday: "long", day: "numeric", month: "long" })
      : `${dayLabel(s.firstDay, locale)} ${t("calendar.to")} ${dayLabel(s.lastDay, locale)}`
    : `${dayLabel(dateOf(toLocal(s.start, tz)), locale, { weekday: "long", day: "numeric", month: "long" })} · ${hhmm(s.start, tz)} ${t("calendar.to")} ${hhmm(s.end, tz)}`;
  const rights = entry?.calendar.myRights;
  const mayEdit = !!rights && (rights.mayWriteAll || rights.mayWriteOwn) && s.organizer;
  const mayDelete = !!rights && (rights.mayDelete || rights.mayWriteAll);
  const description = e.description?.trim();
  const roomAnswer = room?.participationStatus ?? "needs-action";
  return (
    <Panel
      aria-label={t("event.panel")}
      title={eventName(s, t)}
      description={when}
      actions={
        <span className="flex items-center gap-1">
          {entry && <span aria-hidden className="cal-dot" style={hueStyle(entry.hue)} />}
          <IconButton label={t("event.close")} size="xs" variant="ghost" onClick={onClose}>
            <X className="size-3.5" />
          </IconButton>
        </span>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <dl className="m-0 grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 text-xs">
          {!s.allDay && e.timeZone && e.timeZone !== tz && (
            <>
              <dt>
                <Globe aria-label={t("event.timeZone")} className="size-3.5 text-fg-muted" />
              </dt>
              <dd className="m-0 text-fg">
                {t("event.inZone", { time: `${hhmm(s.start, e.timeZone)} ${t("calendar.to")} ${hhmm(s.end, e.timeZone)}`, zone: e.timeZone })}
              </dd>
            </>
          )}
          {room && (
            <>
              <dt>
                <MapPin aria-label={t("event.room")} className="size-3.5 text-fg-muted" />
              </dt>
              <dd className="m-0 text-fg">
                {t(`event.room_${roomAnswer === "accepted" ? "booked" : roomAnswer === "declined" ? "declined" : "waiting"}`, {
                  name: room.name ?? bare(room.calendarAddress),
                })}
              </dd>
            </>
          )}
          {Object.values(e.locations ?? {})
            .filter((l) => l.name !== room?.name)
            .map((l) => (
              <span key={l.name} className="contents">
                <dt>
                  <MapPin aria-label={t("event.where")} className="size-3.5 text-fg-muted" />
                </dt>
                <dd className="m-0 text-fg cal-wrap">{l.name}</dd>
              </span>
            ))}
          {s.base.recurrenceRule && (
            <>
              <dt>
                <Repeat aria-label={t("event.repeats")} className="size-3.5 text-fg-muted" />
              </dt>
              <dd className="m-0 text-fg">{describeRule(s.base.recurrenceRule, ruleWords(t), locale)}</dd>
            </>
          )}
          {Object.values(e.alerts ?? {})[0] && (
            <>
              <dt>
                <Clock aria-label={t("event.reminder")} className="size-3.5 text-fg-muted" />
              </dt>
              <dd className="m-0 text-fg">{t("event.remindBefore", { time: reminderLabel(Object.values(e.alerts!)[0]!.trigger.offset, t) })}</dd>
            </>
          )}
          <dt>
            <CalendarDays aria-label={t("event.calendar")} className="size-3.5 text-fg-muted" />
          </dt>
          <dd className="m-0 text-fg">
            {entry?.label ?? ""}
            {organizer &&
              guests.length > 0 &&
              ` · ${organizer === me ? t("event.organizedByYou") : t("event.organizedBy", { name: people.get(organizer) ?? organizer })}`}
          </dd>
        </dl>
        {e.privacy === "private" && <Badge>{t("event.private")}</Badge>}
        {description && <p className="m-0 whitespace-pre-wrap rounded-md bg-canvas px-2.5 py-2 text-xs text-fg cal-wrap">{description}</p>}
        {guests.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="m-0 text-xs font-semibold text-fg-muted">{t("event.guests", { going, count: guests.length })}</h3>
            <ul aria-label={t("event.guestList")} className="cal-list flex flex-col gap-1">
              {guests.map(([key, p]) => {
                const addr = bare(p.calendarAddress);
                const name = p.name || people.get(addr) || addr;
                const status = p.participationStatus ?? "needs-action";
                return (
                  <li key={key} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Avatar name={name} size="sm" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs text-fg">{addr === me ? t("event.you", { name }) : name}</span>
                        {!people.has(addr) && <span className="truncate text-2xs text-fg-muted">{addr}</span>}
                      </span>
                    </span>
                    <StatusBadge tone={ANSWER_TONE[status]}>{t(`answer.${status}`)}</StatusBadge>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {s.myKey && !s.organizer && (
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <span className="text-xs font-semibold text-fg-muted">{t("event.yourAnswer")}</span>
            <SegmentedControl<Answer>
              label={t("event.yourAnswer")}
              value={s.answer ?? "needs-action"}
              onChange={(a) => (a === "accepted" || a === "tentative" || a === "declined") && onAnswer(a)}
              options={[
                { value: "accepted", label: t("answer.accept") },
                { value: "tentative", label: t("answer.maybe") },
                { value: "declined", label: t("answer.decline") },
              ]}
            />
            {s.recurrenceId && <span className="text-2xs text-fg-muted">{t("event.answerSeries")}</span>}
          </section>
        )}
        {(mayEdit || mayDelete) && (
          <div className="flex gap-1.5 border-t border-line pt-3">
            {mayEdit && (
              <Button size="sm" icon={<Pencil />} onClick={onEdit}>
                {t("event.edit")}
              </Button>
            )}
            {mayDelete && (
              <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={onDelete}>
                {s.organizer ? t("event.delete") : t("event.remove")}
              </Button>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function reminderLabel(offset: string, t: T): string {
  const ms = -parseDuration(offset);
  if (ms <= 0) return t("reminder.atStart");
  if (ms % 86_400_000 === 0) return t("reminder.days", { count: ms / 86_400_000 });
  if (ms % 3_600_000 === 0) return t("reminder.hours", { count: ms / 3_600_000 });
  return t("reminder.minutes", { count: Math.round(ms / 60_000) });
}

// ---------------------------------------------------------------- the page

function ScopeDialog({ open, title, onPick, onClose, t }: { open: boolean; title: string; onPick: (s: Scope) => void; onClose: () => void; t: T }) {
  const [scope, setScope] = useState<Scope>("this");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="sm"
      onSubmit={(e) => (e.preventDefault(), onPick(scope))}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("dialog.ok")}
          </Button>
        </>
      }
    >
      <SegmentedControl<Scope>
        label={title}
        value={scope}
        onChange={setScope}
        options={[
          { value: "this", label: t("scope.this") },
          { value: "following", label: t("scope.following") },
          { value: "all", label: t("scope.all") },
        ]}
      />
    </Dialog>
  );
}

export function CalendarPage({
  call,
  session,
  directory,
  intent,
  onIntentDone,
}: {
  call: Call;
  session: CalendarSession;
  directory: DirectoryList;
  intent?: DialogStart | null;
  onIntentDone?: () => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [tz, setTz] = useTimeZone();
  const [view, setView] = useState<View>(() => remember("view", "week"));
  const [now, setNow] = useState(() => Date.now());
  const today = dateOf(toLocal(now, tz));
  const [anchor, setAnchor] = useState(today);
  const [calendars, setCalendars] = useState<CalendarEntry[]>();
  const [hidden, setHidden] = useState<string[]>(() => remember("hidden", []));
  const [events, setEvents] = useState<Shown[]>([]);
  const [invites, setInvites] = useState<Shown[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogStart | null>(null);
  const [asking, setAsking] = useState<{ kind: "delete"; s: Shown } | null>(null);
  const [colleagues, setColleagues] = useState<string[]>(() => remember("colleagues", []));
  const [adding, setAdding] = useState("");
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [version, setVersion] = useState(0);
  const reminded = useRef(new Set<string>());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (intent) (setDialog(intent), onIntentDone?.());
  }, [intent, onIntentDone]);

  useEffect(() => {
    loadCalendars(call, session, t).then(setCalendars, (e: Error) => setError(e.message));
  }, [call, session, t]);

  const days = useMemo(() => {
    if (view === "day") return [anchor];
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i));
    if (view === "agenda") return Array.from({ length: 30 }, (_, i) => addDays(anchor, i));
    const first = weekStart(monthStart(anchor));
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [view, anchor]);
  const from = toUtc(days[0]!, tz);
  const to = toUtc(addDays(days.at(-1)!, 1), tz);

  const visible = useMemo(() => (calendars ?? []).filter((c) => !hidden.includes(c.key)), [calendars, hidden]);
  const byKey = useMemo(() => new Map((calendars ?? []).map((c) => [c.key, c])), [calendars]);
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of visible) m.set(c.account.id, [...(m.get(c.account.id) ?? []), c.calendar.id]);
    return [...m].map(([accountId, calendarIds]) => ({ accountId, calendarIds }));
  }, [visible]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!calendars) return;
    let live = true;
    loadEvents(call, groups, from, to, session.address, tz).then(
      (list) => live && (setEvents(list), setError(undefined)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [call, calendars, groups, from, to, session.address, tz, version]);

  // Invitations to answer: the next two months of the person's own calendars.
  useEffect(() => {
    if (!calendars) return;
    const own = calendars.filter((c) => c.account.kind === "own");
    const start = Date.now();
    loadEvents(call, [{ accountId: session.accountId, calendarIds: own.map((c) => c.calendar.id) }], start, start + 60 * 86_400_000, session.address, tz).then(
      (list) => {
        const seen = new Set<string>();
        setInvites(list.filter((e) => e.answer === "needs-action" && !e.organizer && !seen.has(e.base.id) && seen.add(e.base.id)));
      },
      () => {},
    );
  }, [call, calendars, session, tz, version]);

  // Colleagues' free and busy times over the shown days.
  useEffect(() => {
    if (!colleagues.length || view === "month" || view === "agenda") return setAvailability(null);
    call<Availability>("/api/v1/availability", {
      method: "POST",
      body: JSON.stringify({ people: colleagues, from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
    }).then(setAvailability, () => setAvailability(null));
  }, [call, colleagues, from, to, view, version]);

  // Reminders while the page is open, for events with a reminder shown on screen.
  useEffect(() => {
    for (const e of events) {
      for (const a of Object.values(e.event.alerts ?? {})) {
        if (a.action === "email") continue;
        const at = e.start + parseDuration(a.trigger.offset);
        const key = `${e.key}@${at}`;
        if (at <= now && now - at < 5 * 60_000 && !reminded.current.has(key)) {
          reminded.current.add(key);
          setNotice(t("reminder.now", { title: eventName(e, t), time: hhmm(e.start, tz) }));
        }
      }
    }
  }, [events, now, t, tz]);

  const hueOf = (s: Shown) => byKey.get(`${s.accountId}/${s.calendarId}`)?.hue ?? PALETTE[0]!;
  const open = events.find((e) => e.key === openKey) ?? invites.find((e) => e.key === openKey);
  const step = (dir: number) =>
    setAnchor(
      view === "day"
        ? addDays(anchor, dir)
        : view === "week"
          ? addDays(anchor, 7 * dir)
          : view === "agenda"
            ? addDays(anchor, 30 * dir)
            : addMonths(anchor, dir),
    );
  const pickView = (v: View) => (keep("view", v), setView(v));
  const toggle = (key: string, on: boolean) => {
    const next = on ? hidden.filter((h) => h !== key) : [...hidden, key];
    keep("hidden", next);
    setHidden(next);
  };
  const setPeople = (list: string[]) => (keep("colleagues", list), setColleagues(list));

  async function answer(s: Shown, a: "accepted" | "tentative" | "declined") {
    try {
      await answerEvent(call, s, a);
      const organizer = organizerOf(s.event);
      setNotice(
        t("answer.sent", {
          answer: t(`answer.${a}`),
          title: eventName(s, t),
          name: directory.people.find((p) => p.address === organizer)?.name ?? organizer ?? "",
        }),
      );
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(s: Shown, scope: Scope) {
    setAsking(null);
    try {
      if (!s.organizer && s.myKey) await answerEvent(call, s, "declined");
      await deleteEvent(call, s, scope);
      setOpenKey(null);
      setNotice(t("event.deleted", { title: eventName(s, t) }));
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const title =
    view === "day"
      ? dayLabel(anchor, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : view === "week"
        ? `${dayLabel(days[0]!, locale, { day: "numeric", month: "long" })} ${t("calendar.to")} ${dayLabel(days[6]!, locale, { day: "numeric", month: "long", year: "numeric" })}`
        : view === "month"
          ? dayLabel(anchor, locale, { month: "long", year: "numeric" })
          : `${dayLabel(days[0]!, locale, { day: "numeric", month: "long" })} ${t("calendar.to")} ${dayLabel(days.at(-1)!, locale, { day: "numeric", month: "long", year: "numeric" })}`;
  const zones = useMemo(() => timeZones(), []);
  const people = new Map(directory.people.map((p) => [p.address, p.name]));
  const busy = (availability ? colleagues : []).map((who, i) => ({
    who,
    name: people.get(who) ?? directory.rooms.find((r) => r.address === who)?.name ?? who,
    hue: PALETTE[(i + 3) % PALETTE.length]!,
    spans: (availability?.busy[who] ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
  }));
  const viewProps: ViewProps = {
    days,
    events,
    hueOf,
    tz,
    today,
    now,
    active: openKey,
    onOpen: (s) => setOpenKey(s.key),
    onSlot: (d, minutes) => {
      if (minutes === -2) return (setAnchor(d), pickView("day"));
      if (minutes === -1 && view !== "day") return (setAnchor(d), pickView("day"));
      setDialog({ date: d, minutes: minutes < 0 ? 9 * 60 : minutes });
    },
    busy,
    locale,
    t,
  };

  let body: ReactNode;
  if (view === "month") body = <MonthGrid {...viewProps} month={monthStart(anchor)} />;
  else if (view === "agenda") body = <Agenda {...viewProps} />;
  else body = <TimeGrid {...viewProps} />;

  return (
    <>
      <PageHeader
        title={title}
        description={`${view === "week" ? `${t("calendar.week", { week: isoWeek(days[0]!) })} · ` : ""}${tz}`}
        actions={
          <>
            <SegmentedControl<View>
              label={t("view.label")}
              value={view}
              onChange={pickView}
              options={[
                { value: "day", label: t("view.day") },
                { value: "week", label: t("view.week") },
                { value: "month", label: t("view.month") },
                { value: "agenda", label: t("view.agenda") },
              ]}
            />
            <span className="flex items-center">
              <IconButton label={t(`calendar.prev.${view}`)} variant="ghost" onClick={() => step(-1)}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <Button variant="ghost" onClick={() => setAnchor(today)}>
                {t("calendar.today")}
              </Button>
              <IconButton label={t(`calendar.next.${view}`)} variant="ghost" onClick={() => step(1)}>
                <ChevronRight className="size-4" />
              </IconButton>
            </span>
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() =>
                setDialog({ date: anchor === today ? today : anchor, minutes: anchor === today ? Math.min((zoned(now, tz).hour + 1) * 60, 23 * 60) : 9 * 60 })
              }
            >
              {t("calendar.new")}
            </Button>
          </>
        }
      />
      {notice && (
        <div role="status" className="cal-gap-below flex items-center justify-between gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
          <span>{notice}</span>
          <IconButton label={t("event.close")} size="xs" variant="ghost" onClick={() => setNotice(null)}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}
      {error && (
        <Callout tone="danger" title={t("calendar.failed")} onDismiss={() => setError(undefined)} className="cal-gap-below">
          <span className="cal-wrap">{error}</span>
        </Callout>
      )}
      <div className="cal-layout">
        <div className="flex flex-col gap-2.5">
          <Panel>
            <MiniMonth date={anchor} today={today} shownFrom={days[0]!} shownTo={addDays(days.at(-1)!, 1)} onPick={setAnchor} locale={locale} t={t} />
          </Panel>
          <Panel title={t("calendar.calendars")}>
            <ul aria-label={t("calendar.calendars")} className="cal-list flex flex-col gap-1.5">
              {(calendars ?? []).map((c) => (
                <li key={c.key} className="flex items-start gap-2">
                  <span aria-hidden className="cal-swatch mt-1" style={hueStyle(c.hue)} />
                  <Checkbox
                    label={c.label}
                    description={
                      c.account.kind === "team"
                        ? t("calendar.team")
                        : c.account.kind === "shared"
                          ? c.calendar.myRights.mayWriteAll || c.calendar.myRights.mayWriteOwn
                            ? t("calendar.sharedEdit")
                            : c.calendar.myRights.mayReadItems
                              ? t("calendar.sharedRead")
                              : t("calendar.sharedBusy")
                          : undefined
                    }
                    checked={!hidden.includes(c.key)}
                    onChange={(e) => toggle(c.key, e.target.checked)}
                    className="min-w-0"
                  />
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title={t("calendar.freeBusy")} description={t("calendar.freeBusyDetail")}>
            <div className="flex flex-col gap-2">
              {colleagues.length > 0 && (
                <ul className="cal-list flex flex-col gap-1" aria-label={t("calendar.freeBusy")}>
                  {colleagues.map((c, i) => (
                    <li key={c} className="flex items-center justify-between gap-1.5 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span aria-hidden className="cal-swatch" style={hueStyle(PALETTE[(i + 3) % PALETTE.length]!)} />
                        <span className="truncate">{people.get(c) ?? directory.rooms.find((r) => r.address === c)?.name ?? c}</span>
                      </span>
                      <IconButton
                        label={t("calendar.stopShowing", { name: people.get(c) ?? c })}
                        size="xs"
                        variant="ghost"
                        onClick={() => setPeople(colleagues.filter((x) => x !== c))}
                      >
                        <X className="size-3" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="flex items-end gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const a = adding.trim().toLowerCase();
                  const found =
                    directory.people.find((p) => p.address === a || p.name.toLowerCase() === a) ??
                    directory.rooms.find((r) => r.address === a || r.name.toLowerCase() === a);
                  const addr = found?.address ?? a;
                  if (addr && !colleagues.includes(addr) && addr !== session.address) setPeople([...colleagues, addr].slice(0, 8));
                  setAdding("");
                }}
              >
                <TextField
                  label={<span className="sr-only">{t("calendar.addColleague")}</span>}
                  placeholder={t("calendar.addColleague")}
                  list="cal-people"
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                />
                <IconButton label={t("calendar.addColleague")} type="submit" variant="secondary">
                  <UserPlus className="size-4" />
                </IconButton>
              </form>
            </div>
          </Panel>
          <SelectField
            label={t("calendar.timeZone")}
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            options={zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))}
          />
        </div>

        <Panel flush aria-label={t(`view.${view}`)}>
          {calendars ? body : <p className="m-0 p-4 text-sm text-fg-muted">{t("calendar.loading")}</p>}
        </Panel>

        <div className="flex flex-col gap-2.5">
          {invites.length > 0 && (
            <Panel title={t("invites.title")} actions={<Badge tone="warning">{invites.length}</Badge>}>
              <ul aria-label={t("invites.list")} className="cal-list flex flex-col gap-2.5">
                {invites.slice(0, 8).map((e) => {
                  const organizer = organizerOf(e.event);
                  return (
                    <li key={e.key} className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        className="flex flex-col border-0 bg-transparent p-0 text-start cursor-pointer"
                        onClick={() => (setAnchor(dateOf(toLocal(e.start, tz))), setOpenKey(e.key))}
                      >
                        <span className="text-sm font-medium text-fg">{eventName(e, t)}</span>
                        <span className="text-xs text-fg-muted">
                          {dayLabel(dateOf(toLocal(e.start, tz)), locale)} {e.allDay ? "" : hhmm(e.start, tz)} ·{" "}
                          {t("invites.from", { name: people.get(organizer ?? "") ?? organizer ?? "" })}
                        </span>
                      </button>
                      <span className="flex gap-1">
                        <Button size="xs" onClick={() => void answer(e, "accepted")}>
                          {t("answer.accept")}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void answer(e, "tentative")}>
                          {t("answer.maybe")}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void answer(e, "declined")}>
                          {t("answer.decline")}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
          {open ? (
            <EventDetail
              key={open.key}
              s={open}
              entry={byKey.get(`${open.accountId}/${open.calendarId}`)}
              tz={tz}
              me={session.address}
              directory={directory}
              onAnswer={(a) => void answer(open, a)}
              onEdit={() => setDialog({ edit: open })}
              onDelete={() => (open.recurrenceId ? setAsking({ kind: "delete", s: open }) : void remove(open, "all"))}
              onClose={() => setOpenKey(null)}
              locale={locale}
              t={t}
            />
          ) : (
            <Panel>
              <p className="m-0 text-sm text-fg-muted">{t("calendar.pick")}</p>
            </Panel>
          )}
        </div>
      </div>
      <datalist id="cal-people">
        {directory.people.map((p) => (
          <option key={p.address} value={p.address}>
            {p.name}
          </option>
        ))}
        {directory.rooms.map((r) => (
          <option key={r.address} value={r.address}>
            {r.name}
          </option>
        ))}
      </datalist>
      {dialog && calendars && (
        <EventDialog
          call={call}
          session={session}
          directory={directory}
          calendars={calendars}
          tz={tz}
          start={dialog}
          onClose={() => setDialog(null)}
          onSaved={(message, date) => {
            setDialog(null);
            setNotice(message);
            if (date) setAnchor(date);
            reload();
          }}
        />
      )}
      <ScopeDialog
        open={!!asking}
        title={t("scope.deleteTitle")}
        onClose={() => setAsking(null)}
        onPick={(scope) => asking && void remove(asking.s, scope)}
        t={t}
      />
    </>
  );
}

/** Saves a calendar's sharing; used by the Sharing page. */
export async function setShares(call: Call, accountId: string, calendarId: string, shareWith: Record<string, Partial<CalendarObj["myRights"]>>) {
  const r = await jmap(call, [["Calendar/set", { accountId, update: { [calendarId]: { shareWith } } }, "s"]]);
  checkSet(r.s);
}
