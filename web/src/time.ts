import { viewerLocale } from "./i18n.ts";
// Times in the pages. An event keeps its own time zone (JSCalendar: a local start, a time zone and a duration, RFC
// 8984); the pages show it in the time zone the person picked, which is their browser's unless they change it. The
// mail server expands repeating events; these helpers only convert and format.

/** A local date and time without a zone, as JSCalendar writes it: 2026-11-04T14:30:00. */
export type LocalDateTime = string;

export interface Parts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Monday, 6 is Sunday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(viewerLocale(), {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The wall-clock time in a zone at an instant. */
export function zoned(ms: number, tz: string): Parts {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday ?? "Mon"),
  };
}

/** How far a zone is ahead of UTC at an instant, in milliseconds. */
export function offset(ms: number, tz: string): number {
  const p = zoned(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in a zone is; a time skipped by a clock change moves forward with the clock. */
export function toUtc(local: LocalDateTime, tz: string): number {
  const [d, t = "00:00:00"] = local.split("T");
  const [y, mo, da] = d!.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const guess = Date.UTC(y!, mo! - 1, da!, h ?? 0, mi ?? 0, s ?? 0);
  const first = guess - offset(guess, tz);
  const second = guess - offset(first, tz);
  return second;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The wall-clock time in a zone, as a LocalDateTime. */
export function toLocal(ms: number, tz: string): LocalDateTime {
  const p = zoned(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** The date part, 2026-11-04. */
export const dateOf = (l: LocalDateTime) => l.slice(0, 10);
/** The time part, 14:30. */
export const timeOf = (l: LocalDateTime) => l.slice(11, 16);

/** A calendar date moved by whole days; dates are taken as UTC so no zone gets in the way. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + months, 1)).toISOString().slice(0, 10);
}

/** 0 is Monday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}

/** The Monday of the week a date is in. */
export const weekStart = (date: string) => addDays(date, -weekdayOf(date));
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** Whole days from one date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** ISO 8601 week number of a date. */
export function isoWeek(date: string): number {
  const thursday = addDays(date, 3 - weekdayOf(date));
  const jan4 = `${thursday.slice(0, 4)}-01-04`;
  return 1 + Math.round(daysBetween(weekStart(jan4), weekStart(thursday)) / 7);
}

/** A JSCalendar duration such as PT1H30M or P1D, in milliseconds; weeks and days count as 24 hours each. */
export function parseDuration(d: string | null | undefined): number {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d ?? "");
  if (!m) return 0;
  const [, neg, w, dd, h, mi, s] = m;
  const ms = ((Number(w ?? 0) * 7 + Number(dd ?? 0)) * 24 * 3600 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return neg ? -ms : ms;
}

/** Milliseconds as a JSCalendar duration: whole days as P1D, the rest as PT1H30M. */
export function formatDuration(ms: number): string {
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86_400);
  s -= days * 86_400;
  const h = Math.floor(s / 3600);
  const mi = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const time = `${h ? `${h}H` : ""}${mi ? `${mi}M` : ""}${sec ? `${sec}S` : ""}`;
  const out = `P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
  return `${neg ? "-" : ""}${out === "P" ? "PT0S" : out}`;
}

/** The time zones the browser knows, with UTC first. */
export function timeZones(): string[] {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return ["UTC", ...all.filter((z) => z !== "UTC")];
}

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Hours as 09:30. */
export function hhmm(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** A date in words in a locale: "Wed 4 November". */
export function dayLabel(date: string, locale: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "long" }): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

/** Weekday names from Monday, in a locale. */
export function weekdayNames(locale: string, width: "short" | "long" | "narrow" = "short"): string[] {
  return Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 2 + i))));
}

// ------------------------------------------------------------------ repeating

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";
export const DAY_CODES = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
export type DayCode = (typeof DAY_CODES)[number];

/** JSCalendar's RecurrenceRule, as far as the pages write it. */
export interface RecurrenceRule {
  "@type"?: "RecurrenceRule";
  frequency: Frequency;
  interval?: number;
  byDay?: Array<{ "@type"?: "NDay"; day: DayCode; nthOfPeriod?: number }>;
  byMonthDay?: number[];
  count?: number;
  until?: LocalDateTime;
}

/** What the repeat field of the event form offers. */
export type RepeatChoice = "none" | "daily" | "weekdays" | "weekly" | "monthly-day" | "monthly-nth" | "yearly" | "custom";

/** Which nth weekday of its month a date is: 1 to 5, or -1 for the last. */
export function nthOfMonth(date: string): { nth: number; last: boolean } {
  const day = Number(date.slice(8, 10));
  const nth = Math.ceil(day / 7);
  const last = Number(addDays(date, 7).slice(5, 7)) !== Number(date.slice(5, 7));
  return { nth, last };
}

/** The rule for a repeat choice, starting on a date. */
export function ruleFor(choice: RepeatChoice, date: string, custom?: { frequency: Frequency; interval: number; days: DayCode[] }): RecurrenceRule | null {
  const day = DAY_CODES[weekdayOf(date)]!;
  switch (choice) {
    case "none":
      return null;
    case "daily":
      return { "@type": "RecurrenceRule", frequency: "daily" };
    case "weekdays":
      return { "@type": "RecurrenceRule", frequency: "weekly", byDay: (["mo", "tu", "we", "th", "fr"] as const).map((d) => ({ "@type": "NDay", day: d })) };
    case "weekly":
      return { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ "@type": "NDay", day }] };
    case "monthly-day":
      return { "@type": "RecurrenceRule", frequency: "monthly", byMonthDay: [Number(date.slice(8, 10))] };
    case "monthly-nth": {
      const { nth, last } = nthOfMonth(date);
      return { "@type": "RecurrenceRule", frequency: "monthly", byDay: [{ "@type": "NDay", day, nthOfPeriod: last && nth >= 4 ? -1 : nth }] };
    }
    case "yearly":
      return { "@type": "RecurrenceRule", frequency: "yearly" };
    case "custom": {
      const c = custom ?? { frequency: "weekly", interval: 1, days: [day] };
      return {
        "@type": "RecurrenceRule",
        frequency: c.frequency,
        ...(c.interval > 1 ? { interval: c.interval } : {}),
        ...(c.frequency === "weekly" && c.days.length ? { byDay: c.days.map((d) => ({ "@type": "NDay" as const, day: d })) } : {}),
      };
    }
  }
}

/** The repeat choice a rule matches, for the form; custom when none does. */
export function choiceOf(rule: RecurrenceRule | null | undefined, date: string): RepeatChoice {
  if (!rule) return "none";
  const plain = (r: RecurrenceRule | null) =>
    JSON.stringify({ ...r, count: undefined, until: undefined, "@type": undefined, byDay: r?.byDay?.map((d) => ({ day: d.day, nthOfPeriod: d.nthOfPeriod })) });
  for (const c of ["daily", "weekdays", "weekly", "monthly-day", "monthly-nth", "yearly"] as RepeatChoice[])
    if (plain(ruleFor(c, date)) === plain(rule)) return c;
  return "custom";
}

/** Strings a rule is described with, in the page's language. */
export interface RuleWords {
  every: (unit: "day" | "week" | "month" | "year", interval: number) => string;
  weekdays: string;
  onDays: (days: string) => string;
  onMonthDay: (day: number) => string;
  onNth: (nth: number, day: string) => string;
  times: (count: number) => string;
  until: (date: string) => string;
}

/** "Every 2 weeks on Monday, Wednesday, until 30 June 2027". */
export function describeRule(rule: RecurrenceRule, words: RuleWords, locale: string): string {
  const names = weekdayNames(locale, "long");
  const unit = ({ daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const)[rule.frequency];
  const interval = rule.interval ?? 1;
  const days = (rule.byDay ?? []).filter((d) => !d.nthOfPeriod);
  const parts: string[] = [];
  const isWeekdays =
    rule.frequency === "weekly" && interval === 1 && days.length === 5 && ["mo", "tu", "we", "th", "fr"].every((d) => days.some((x) => x.day === d));
  if (isWeekdays) parts.push(words.weekdays);
  else {
    parts.push(words.every(unit, interval));
    if (days.length) parts.push(words.onDays(days.map((d) => names[DAY_CODES.indexOf(d.day)]!).join(", ")));
    const nth = (rule.byDay ?? []).find((d) => d.nthOfPeriod);
    if (nth) parts.push(words.onNth(nth.nthOfPeriod!, names[DAY_CODES.indexOf(nth.day)]!));
    if (rule.byMonthDay?.length) parts.push(words.onMonthDay(rule.byMonthDay[0]!));
  }
  if (rule.count) parts.push(words.times(rule.count));
  if (rule.until) parts.push(words.until(dayLabel(dateOf(rule.until), locale, { day: "numeric", month: "long", year: "numeric" })));
  return parts.join(" ");
}
