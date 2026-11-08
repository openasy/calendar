import { Badge, Button, Checkbox, Dialog, SegmentedControl, SelectField, TextField, useLocalePreference } from "@openasy/ui";
import { X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Availability, Call, CalendarSession, DirectoryList } from "./api.ts";
import type { CalendarEntry } from "./Calendar.tsx";
import { reminderLabel } from "./Calendar.tsx";
import { createEvent, eventToForm, firstFree, formToEvent, updateEvent, type EventForm, type Guest, type Scope, type Shown } from "./events.ts";
import { useT } from "./i18n.ts";
import {
  addDays,
  choiceOf,
  DAY_CODES,
  dayLabel,
  daysBetween,
  hhmm,
  nthOfMonth,
  timeZones,
  toUtc,
  weekdayNames,
  weekdayOf,
  type DayCode,
  type Frequency,
  type RepeatChoice,
} from "./time.ts";

/** How the dialog opens: on a day and time, to change an event, or with guests from the contacts. */
export type DialogStart = { date: string; minutes: number; guests?: Guest[] } | { edit: Shown };

const REMINDERS = ["", "PT0S", "-PT5M", "-PT10M", "-PT15M", "-PT30M", "-PT1H", "-PT2H", "-P1D", "-P2D", "-P7D"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
const FIND_FROM = 8;
const FIND_TO = 18;

function blank(start: { date: string; minutes: number; guests?: Guest[] }, tz: string, calendar: string): EventForm {
  const end = Math.min(start.minutes + 60, 23 * 60 + 59);
  return {
    title: "",
    description: "",
    location: "",
    allDay: false,
    date: start.date,
    startTime: at(start.minutes),
    endDate: start.date,
    endTime: at(end),
    timeZone: tz,
    repeat: "none",
    custom: { frequency: "weekly", interval: 1, days: [DAY_CODES[weekdayOf(start.date)]!] },
    ends: "never",
    until: "",
    count: 10,
    guests: start.guests ?? [],
    room: "",
    reminder: "-PT10M",
    reminderBy: "display",
    privacy: "public",
    free: false,
    calendar,
  };
}

export function EventDialog({
  call,
  session,
  directory,
  calendars,
  tz,
  start,
  onClose,
  onSaved,
}: {
  call: Call;
  session: CalendarSession;
  directory: DirectoryList;
  calendars: CalendarEntry[];
  tz: string;
  start: DialogStart;
  onClose: () => void;
  onSaved: (message: string, date?: string) => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const editing = "edit" in start ? start.edit : null;
  const writable = calendars.filter((c) => c.calendar.myRights.mayWriteAll || c.calendar.myRights.mayWriteOwn);
  const fallback = (writable.find((c) => c.account.kind === "own" && c.calendar.isDefault) ?? writable[0])?.key ?? "";
  const [form, setForm] = useState<EventForm>(() => {
    if (!editing) {
      // A room among the guests, as the Rooms page sends it, is the room booked.
      const s = start as { date: string; minutes: number; guests?: Guest[] };
      const room = s.guests?.find((g) => directory.rooms.some((r) => r.address === g.email));
      return { ...blank({ ...s, guests: s.guests?.filter((g) => g !== room) }, tz, fallback), room: room?.email ?? "" };
    }
    const f = eventToForm(editing, tz, directory.rooms, session.address);
    return { ...f, repeat: choiceOf(editing.base.recurrenceRule, f.date) };
  });
  const [scope, setScope] = useState<Scope>("this");
  const [guest, setGuest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const set = <K extends keyof EventForm>(k: K, v: EventForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const zones = useMemo(() => timeZones(), []);
  const people = new Map(directory.people.map((p) => [p.address, p.name]));

  // Everyone's busy times on the chosen day, to find a time and to see which rooms are free.
  const who = useMemo(
    () => [...new Set([session.address, ...form.guests.map((g) => g.email.toLowerCase()), ...directory.rooms.map((r) => r.address)])].slice(0, 30),
    [session.address, form.guests, directory.rooms],
  );
  const zone = form.allDay ? tz : form.timeZone;
  const dayStart = toUtc(form.date, zone);
  useEffect(() => {
    let live = true;
    call<Availability>("/api/v1/availability", {
      method: "POST",
      body: JSON.stringify({ people: who, from: new Date(dayStart).toISOString(), to: new Date(dayStart + 86_400_000).toISOString() }),
    }).then(
      (a) => live && setAvailability(a),
      () => live && setAvailability(null),
    );
    return () => {
      live = false;
    };
  }, [call, who, dayStart]);

  const slotStart = form.allDay ? dayStart : toUtc(`${form.date}T${form.startTime}:00`, zone);
  const slotEnd = form.allDay ? toUtc(addDays(form.endDate, 1), zone) : toUtc(`${form.endDate}T${form.endTime}:00`, zone);
  const minutes = Math.max(15, Math.round((slotEnd - slotStart) / 60_000));
  const spans = (addr: string) =>
    (availability?.busy[addr] ?? [])
      .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
      // The event being changed is not in the way of itself.
      .filter((b) => !(editing && b.start === editing.start && b.end === editing.end));
  const roomTaken = (addr: string) => spans(addr).some((b) => b.start < slotEnd && slotStart < b.end);
  const mayBook = (r: DirectoryList["rooms"][number]) => !r.bookers.length || r.bookers.includes(session.address);
  const everyone = [session.address, ...form.guests.map((g) => g.email.toLowerCase()), ...(form.room ? [form.room] : [])];
  const suggestion = availability && !form.allDay ? firstFree(everyone.flatMap(spans), dayStart, FIND_FROM, FIND_TO, minutes) : null;

  function addGuest(text: string) {
    const parts = text
      .split(/[,;\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const next = [...form.guests];
    for (const p of parts) {
      const found = directory.people.find((x) => x.address === p.toLowerCase() || x.name.toLowerCase() === p.toLowerCase());
      const email = (found?.address ?? p).toLowerCase();
      if (!EMAIL.test(email)) return setError(t("dialog.notAnAddress", { text: p }));
      if (directory.rooms.some((r) => r.address === email)) {
        set("room", email);
        continue;
      }
      if (email !== session.address && !next.some((g) => g.email === email)) next.push({ email, name: found?.name ?? "" });
    }
    setError(undefined);
    set("guests", next);
    setGuest("");
  }

  async function save() {
    if (!form.title.trim()) return setError(t("dialog.needTitle"));
    if (slotEnd <= slotStart) return setError(t("dialog.endAfterStart"));
    if (guest.trim()) addGuest(guest);
    setBusy(true);
    setError(undefined);
    try {
      const [accountId, calendarId] = form.calendar.split("/") as [string, string];
      const me = { address: session.address, name: session.name ?? session.address };
      const data = formToEvent(form, me, directory.rooms, editing?.event);
      if (editing) await updateEvent(call, editing, data, scope, { accountId, calendarId });
      else await createEvent(call, accountId, calendarId, data);
      const room = directory.rooms.find((r) => r.address === form.room);
      const guests = form.guests.length;
      onSaved(
        [
          t("dialog.saved", { title: form.title.trim() }),
          guests ? t("dialog.invited", { count: guests }) : "",
          room ? t("dialog.roomAnswers", { name: room.name }) : "",
        ]
          .filter(Boolean)
          .join(" "),
        form.date,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nth = nthOfMonth(form.date);
  const dayName = weekdayNames(locale, "long")[weekdayOf(form.date)]!;
  const repeatOptions: Array<{ value: RepeatChoice; label: string }> = [
    { value: "none", label: t("repeat.none") },
    { value: "daily", label: t("repeat.daily") },
    { value: "weekdays", label: t("repeat.everyWeekday") },
    { value: "weekly", label: t("repeat.weekly", { day: dayName }) },
    { value: "monthly-day", label: t("repeat.monthlyDay", { day: Number(form.date.slice(8)) }) },
    {
      value: "monthly-nth",
      label: t("repeat.monthlyNth", {
        nth: nth.last && nth.nth >= 4 ? t("repeat.last") : t(`repeat.nth.${Math.min(nth.nth, 5)}` as "repeat.nth.1"),
        day: dayName,
      }),
    },
    { value: "yearly", label: t("repeat.yearly", { date: dayLabel(form.date, locale, { day: "numeric", month: "long" }) }) },
    { value: "custom", label: t("repeat.custom") },
  ];
  const span = FIND_TO - FIND_FROM;
  const pct = (ms: number) => `${Math.min(Math.max(((ms - dayStart) / 3_600_000 - FIND_FROM) / span, 0), 1) * 100}%`;
  const width = (a: number, b: number) => `calc(${pct(b)} - ${pct(a)})`;
  const recurring = !!editing?.recurrenceId;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={editing ? t("dialog.editTitle") : t("dialog.newTitle")}
      description={t("dialog.description")}
      size="lg"
      onSubmit={(e) => (e.preventDefault(), void save())}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {form.guests.length || form.room ? t("dialog.saveInvite") : t("dialog.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="m-0 text-sm text-danger cal-wrap">{error}</p>}
        <TextField
          label={t("dialog.title")}
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder={t("dialog.titlePlaceholder")}
          maxLength={300}
        />
        {recurring && (
          <SegmentedControl<Scope>
            label={t("scope.editTitle")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "this", label: t("scope.this") },
              { value: "following", label: t("scope.following") },
              { value: "all", label: t("scope.all") },
            ]}
          />
        )}
        <Checkbox
          label={t("dialog.allDay")}
          checked={form.allDay}
          // An all-day event, such as a holiday or a deadline, leaves the day free unless changed, as calendar apps do.
          onChange={(e) => setForm((f) => ({ ...f, allDay: e.target.checked, free: e.target.checked }))}
        />
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label={t("dialog.starts")}
            type="date"
            value={form.date}
            onChange={(e) => {
              const date = e.target.value;
              // The end moves with the start, so the event keeps its length.
              if (date) setForm((f) => ({ ...f, date, endDate: addDays(f.endDate, daysBetween(f.date, date)) }));
            }}
            required
          />
          {!form.allDay && <TextField label={t("dialog.at")} type="time" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} required />}
          <TextField label={t("dialog.ends")} type="date" value={form.endDate} min={form.date} onChange={(e) => set("endDate", e.target.value)} required />
          {!form.allDay && <TextField label={t("dialog.at")} type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} required />}
        </div>
        {!form.allDay && (
          <SelectField
            label={t("dialog.timeZone")}
            value={form.timeZone}
            onChange={(e) => set("timeZone", e.target.value)}
            options={zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))}
          />
        )}
        <SelectField label={t("dialog.repeat")} value={form.repeat} onChange={(e) => set("repeat", e.target.value as RepeatChoice)} options={repeatOptions} />
        {form.repeat === "custom" && (
          <div className="grid grid-cols-2 gap-2">
            <TextField
              label={t("repeat.interval")}
              type="number"
              min={1}
              max={99}
              value={form.custom.interval}
              onChange={(e) => set("custom", { ...form.custom, interval: Math.max(1, Number(e.target.value) || 1) })}
            />
            <SelectField
              label={t("repeat.unit")}
              value={form.custom.frequency}
              onChange={(e) => set("custom", { ...form.custom, frequency: e.target.value as Frequency })}
              options={(["daily", "weekly", "monthly", "yearly"] as const).map((f) => ({ value: f, label: t(`repeat.units.${f}`) }))}
            />
            {form.custom.frequency === "weekly" && (
              <fieldset className="col-span-2 m-0 flex flex-wrap gap-2 border-0 p-0">
                <legend className="mb-1 text-xs font-medium text-fg">{t("repeat.onWhich")}</legend>
                {weekdayNames(locale).map((name, i) => {
                  const code = DAY_CODES[i] as DayCode;
                  return (
                    <Checkbox
                      key={code}
                      label={name}
                      checked={form.custom.days.includes(code)}
                      onChange={(e) =>
                        set("custom", { ...form.custom, days: e.target.checked ? [...form.custom.days, code] : form.custom.days.filter((d) => d !== code) })
                      }
                    />
                  );
                })}
              </fieldset>
            )}
          </div>
        )}
        {form.repeat !== "none" && (
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label={t("repeat.endsLabel")}
              value={form.ends}
              onChange={(e) => set("ends", e.target.value as EventForm["ends"])}
              options={[
                { value: "never", label: t("repeat.never") },
                { value: "until", label: t("repeat.onDate") },
                { value: "count", label: t("repeat.afterCount") },
              ]}
            />
            {form.ends === "until" && (
              <TextField label={t("repeat.lastDay")} type="date" min={form.date} value={form.until} onChange={(e) => set("until", e.target.value)} required />
            )}
            {form.ends === "count" && (
              <TextField
                label={t("repeat.howMany")}
                type="number"
                min={1}
                max={999}
                value={form.count}
                onChange={(e) => set("count", Math.max(1, Number(e.target.value) || 1))}
              />
            )}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-1.5">
            <TextField
              label={t("dialog.guests")}
              hint={t("dialog.guestsHint")}
              list="cal-people"
              value={guest}
              onChange={(e) => setGuest(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === ",") && guest.trim()) (e.preventDefault(), addGuest(guest));
              }}
              placeholder={t("dialog.guestsPlaceholder")}
            />
            <Button type="button" onClick={() => guest.trim() && addGuest(guest)}>
              {t("dialog.add")}
            </Button>
          </div>
          {form.guests.length > 0 && (
            <ul aria-label={t("dialog.guests")} className="cal-list flex flex-wrap gap-1">
              {form.guests.map((g) => (
                <li key={g.email}>
                  <Badge>
                    {g.name || people.get(g.email) || g.email}
                    <button
                      type="button"
                      className="cal-chip-remove"
                      aria-label={t("dialog.removeGuest", { name: g.name || g.email })}
                      onClick={() =>
                        set(
                          "guests",
                          form.guests.filter((x) => x.email !== g.email),
                        )
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        {directory.rooms.length > 0 && (
          <SelectField
            label={t("dialog.room")}
            value={form.room}
            onChange={(e) => set("room", e.target.value)}
            options={[
              { value: "", label: t("dialog.noRoom") },
              ...directory.rooms.map((r) => ({
                value: r.address,
                label: [
                  r.name,
                  r.seats ? t("rooms.seats", { count: r.seats }) : "",
                  !mayBook(r) ? t("dialog.roomNotYours") : roomTaken(r.address) ? t("dialog.roomTaken") : "",
                ]
                  .filter(Boolean)
                  .join(", "),
              })),
            ]}
          />
        )}
        {!form.allDay && (form.guests.length > 0 || form.room) && (
          <section aria-label={t("find.title")} className="flex flex-col gap-1.5 rounded-md border border-line p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-fg">{t("find.title")}</span>
              {suggestion !== null && suggestion !== slotStart && (
                <Button
                  size="xs"
                  type="button"
                  onClick={() => {
                    const startAt = hhmm(suggestion, zone);
                    const endAt = hhmm(suggestion + minutes * 60_000, zone);
                    setForm((f) => ({ ...f, startTime: startAt, endTime: endAt, endDate: f.date }));
                  }}
                >
                  {t("find.use", { time: hhmm(suggestion, zone) })}
                </Button>
              )}
            </div>
            {!availability ? (
              <span className="text-xs text-fg-muted">{t("calendar.loading")}</span>
            ) : (
              <div className="cal-find" style={{ "--cal-span": span } as CSSProperties}>
                {everyone.map((addr) => {
                  const list = availability.busy[addr];
                  const name = addr === session.address ? t("find.you") : (people.get(addr) ?? directory.rooms.find((r) => r.address === addr)?.name ?? addr);
                  return (
                    <span key={addr} className="contents">
                      <span className="truncate">{name}</span>
                      {list === null || list === undefined ? (
                        <span className="text-2xs text-fg-muted">{t("find.unknown")}</span>
                      ) : (
                        <span className="cal-find-track" role="img" aria-label={t("find.busyCount", { name, count: spans(addr).length })}>
                          {spans(addr).map((b) => (
                            <span
                              key={b.start}
                              className="cal-find-busy"
                              style={{ left: pct(b.start), width: width(b.start, b.end) }}
                              title={`${hhmm(b.start, zone)} ${t("calendar.to")} ${hhmm(b.end, zone)}`}
                            />
                          ))}
                          <span className="cal-find-pick" style={{ left: pct(slotStart), width: width(slotStart, slotEnd) }} />
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            <span className="text-2xs text-fg-muted">
              {suggestion === null && availability ? t("find.none", { from: FIND_FROM, to: FIND_TO }) : t("find.detail", { from: FIND_FROM, to: FIND_TO })}
            </span>
          </section>
        )}
        <TextField
          label={t("dialog.location")}
          value={form.location}
          onChange={(e) => set("location", e.target.value)}
          placeholder={t("dialog.locationPlaceholder")}
          maxLength={300}
        />
        <label className="flex flex-col gap-1 text-xs font-medium text-fg">
          {t("dialog.notes")}
          <textarea className="cal-textarea" value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={10_000} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            label={t("dialog.reminder")}
            value={form.reminder}
            onChange={(e) => set("reminder", e.target.value)}
            options={REMINDERS.map((r) => ({ value: r, label: r ? reminderLabel(r, t) : t("reminder.none") }))}
          />
          {form.reminder && (
            <SelectField
              label={t("dialog.reminderBy")}
              value={form.reminderBy}
              onChange={(e) => set("reminderBy", e.target.value as EventForm["reminderBy"])}
              options={[
                { value: "display", label: t("reminder.display") },
                { value: "email", label: t("reminder.email") },
              ]}
            />
          )}
          <SelectField
            label={t("dialog.calendar")}
            value={form.calendar}
            onChange={(e) => set("calendar", e.target.value)}
            options={writable.map((c) => ({ value: c.key, label: c.label }))}
            disabled={!!editing && recurring && scope === "this"}
          />
          <SelectField
            label={t("dialog.visibility")}
            value={`${form.privacy}/${form.free ? "free" : "busy"}`}
            onChange={(e) => {
              const [privacy, show] = e.target.value.split("/") as [EventForm["privacy"], string];
              setForm((f) => ({ ...f, privacy, free: show === "free" }));
            }}
            options={[
              { value: "public/busy", label: t("dialog.busyPublic") },
              { value: "private/busy", label: t("dialog.busyPrivate") },
              { value: "public/free", label: t("dialog.free") },
            ]}
          />
        </div>
      </div>
    </Dialog>
  );
}
