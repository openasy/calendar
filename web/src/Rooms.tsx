import { Badge, Button, Callout, EmptyState, IconButton, KpiCard, KpiGrid, PageHeader, Panel, StatusBadge, useAgo, useLocalePreference } from "@openasy/ui";
import { ChevronLeft, ChevronRight, DoorOpen, Plus } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { Call, RoomDay } from "./api.ts";
import { useTimeZone } from "./Calendar.tsx";
import { useT } from "./i18n.ts";
import { addDays, dateOf, dayLabel, hhmm, toLocal, toUtc } from "./time.ts";

const FIRST = 8;
const LAST = 18;

/** Every room's bookings on one day, and what each room accepts on its own. */
export function RoomsPage({ call, onBook }: { call: Call; onBook: (room: string, date: string) => void }) {
  const t = useT();
  const ago = useAgo();
  const [locale] = useLocalePreference();
  const [tz] = useTimeZone();
  const [now] = useState(() => Date.now());
  const today = dateOf(toLocal(now, tz));
  const [date, setDate] = useState(today);
  const [data, setData] = useState<RoomDay>();
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const from = toUtc(date, tz);
    const to = toUtc(addDays(date, 1), tz);
    setData(undefined);
    call<RoomDay>(`/api/v1/rooms?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`).then(
      (d) => (setData(d), setActive((a) => a ?? d.rooms[0]?.address ?? null)),
      (e: Error) => setError(e.message),
    );
  }, [call, date, tz]);

  const dayStart = toUtc(date, tz);
  const pct = (ms: number) => `${Math.min(Math.max(((ms - dayStart) / 3_600_000 - FIRST) / (LAST - FIRST), 0), 1) * 100}%`;
  const room = data?.rooms.find((r) => r.address === active) ?? data?.rooms[0];
  const hours = Array.from({ length: LAST - FIRST + 1 }, (_, i) => FIRST + i);
  // How much of the working day the rooms are booked.
  const booked = data
    ? data.rooms.reduce(
        (n, r) =>
          n +
          r.bookings.reduce(
            (m, b) => m + Math.max(0, Math.min(Date.parse(b.end), dayStart + LAST * 3_600_000) - Math.max(Date.parse(b.start), dayStart + FIRST * 3_600_000)),
            0,
          ),
        0,
      ) / Math.max(1, data.rooms.length * (LAST - FIRST) * 3_600_000)
    : 0;
  const busiest = data?.rooms
    .map((r) => ({ name: r.name, hours: r.bookings.reduce((m, b) => m + (Date.parse(b.end) - Date.parse(b.start)), 0) / 3_600_000 }))
    .sort((a, b) => b.hours - a.hours)[0];

  return (
    <>
      <PageHeader
        title={t("rooms.title")}
        description={t("rooms.description")}
        actions={
          <span className="flex items-center">
            <IconButton label={t("rooms.prevDay")} variant="ghost" onClick={() => setDate(addDays(date, -1))}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <Button variant="ghost" onClick={() => setDate(today)}>
              {date === today
                ? t("rooms.today", { day: dayLabel(date, locale, { weekday: "long", day: "numeric", month: "long" }) })
                : dayLabel(date, locale, { weekday: "long", day: "numeric", month: "long" })}
            </Button>
            <IconButton label={t("rooms.nextDay")} variant="ghost" onClick={() => setDate(addDays(date, 1))}>
              <ChevronRight className="size-4" />
            </IconButton>
          </span>
        }
      />
      {error && (
        <Callout tone="danger" title={t("rooms.failed")} onDismiss={() => setError(undefined)} className="cal-gap-below">
          {error}
        </Callout>
      )}
      {data && data.rooms.length === 0 ? (
        <EmptyState icon={<DoorOpen />} title={t("rooms.none")}>
          {t("rooms.noneDetail")}
          <pre className="cal-code mt-2">
            {"rooms:\n  - address: lisbon@rooms.example.com\n    name: Lisbon\n    seats: 6\n    features: [Screen, Video bar]"}
          </pre>
        </EmptyState>
      ) : (
        <>
          <KpiGrid minWidth={170} className="cal-gap-below">
            <KpiCard label={t("rooms.count")} value={data?.rooms.length ?? "–"} icon={DoorOpen} />
            <KpiCard
              label={t("rooms.booked")}
              value={data ? Math.round(booked * 100) : "–"}
              unit="%"
              delta={busiest ? { label: t("rooms.busiest", { name: busiest.name, hours: Math.round(busiest.hours * 10) / 10 }), intent: "neutral" } : undefined}
            />
            <KpiCard label={t("rooms.accepted")} value={data?.lastWeek.accepted ?? "–"} delta={{ label: t("rooms.lastWeek"), intent: "neutral" }} />
            <KpiCard label={t("rooms.declined")} value={data?.lastWeek.declined ?? "–"} delta={{ label: t("rooms.lastWeek"), intent: "neutral" }} />
          </KpiGrid>
          <div className="cal-side cal-side-wide">
            <Panel flush aria-label={t("rooms.bookings")}>
              <div className="cal-scroll">
                <div className="cal-rooms border-b border-line">
                  <span className="px-3 py-1.5 text-2xs font-semibold tracking-wide text-fg-muted uppercase">{t("rooms.room")}</span>
                  <span className="cal-scale mr-3">
                    {hours.map((h) => (
                      <span key={h} style={{ left: `${((h - FIRST) / (LAST - FIRST)) * 100}%` }}>
                        {String(h).padStart(2, "0")}:00
                      </span>
                    ))}
                  </span>
                </div>
                <ul aria-label={t("rooms.title")} className="cal-list">
                  {(data?.rooms ?? []).map((r) => (
                    <li key={r.address} className={`cal-rooms cal-room-row ${r.address === room?.address ? "cal-room-active" : ""}`}>
                      <button type="button" className="cal-room-name" onClick={() => setActive(r.address)} aria-pressed={r.address === room?.address}>
                        <span className="text-sm font-medium text-fg">{r.name}</span>
                        <span className="text-2xs text-fg-muted">
                          {[r.seats ? t("rooms.seats", { count: r.seats }) : t(`rooms.kind.${r.kind}`), r.location].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                      <span className="cal-track" style={{ "--cal-span": LAST - FIRST } as CSSProperties}>
                        {r.bookings.map((b) => {
                          const s = Date.parse(b.start);
                          const e = Date.parse(b.end);
                          const hue = b.mine ? "var(--oa-chart-1)" : b.title === null ? "var(--oa-chart-4)" : "var(--oa-chart-2)";
                          return (
                            <span
                              key={b.start}
                              className="cal-booking"
                              title={`${b.title ?? t("rooms.private")}, ${hhmm(s, tz)} ${t("calendar.to")} ${hhmm(e, tz)}${b.organizerName ? `, ${b.organizerName}` : ""}`}
                              style={{ "--cal-hue": hue, left: pct(s), width: `calc(${pct(e)} - ${pct(s)} - 2px)` } as CSSProperties}
                            >
                              <span className="truncate font-semibold">{b.title ?? t("rooms.busy")}</span>
                              <span className="truncate text-fg-muted">{b.mine ? t("rooms.you") : b.organizerName}</span>
                            </span>
                          );
                        })}
                        {date === today && (
                          <span className="cal-track-now" role="img" aria-label={t("rooms.now", { time: hhmm(now, tz) })} style={{ left: pct(now) }} />
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {!data && <p className="m-0 p-4 text-sm text-fg-muted">{t("calendar.loading")}</p>}
              </div>
            </Panel>
            {room && (
              <div className="flex flex-col gap-2.5">
                <Panel
                  aria-label={t("rooms.room")}
                  title={room.name}
                  description={[room.seats ? t("rooms.seats", { count: room.seats }) : t(`rooms.kind.${room.kind}`), room.location].filter(Boolean).join(" · ")}
                  actions={
                    <Button size="sm" icon={<Plus />} onClick={() => onBook(room.address, date)}>
                      {t("rooms.book")}
                    </Button>
                  }
                >
                  <div className="flex flex-col gap-3 text-sm">
                    {room.features.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {room.features.map((f) => (
                          <Badge key={f}>{f}</Badge>
                        ))}
                      </div>
                    )}
                    {room.unavailable && <StatusBadge tone="warning">{t("rooms.unavailable")}</StatusBadge>}
                    <dl className="cal-settings m-0 text-xs">
                      <dt className="text-fg-muted">{t("rooms.address")}</dt>
                      <dd className="m-0 font-mono text-fg cal-wrap">{room.address}</dd>
                      <dt className="text-fg-muted">{t("rooms.accepts")}</dt>
                      <dd className="m-0 text-fg">{t("rooms.acceptsDetail", { days: room.bookAhead })}</dd>
                      <dt className="text-fg-muted">{t("rooms.whoBooks")}</dt>
                      <dd className="m-0 text-fg cal-wrap">{room.bookers.length ? room.bookers.join(", ") : t("rooms.everyone")}</dd>
                    </dl>
                    <section className="flex flex-col gap-1.5 border-t border-line pt-3">
                      <h3 className="m-0 text-xs font-semibold text-fg-muted">{date === today ? t("rooms.todayList") : dayLabel(date, locale)}</h3>
                      {room.bookings.length ? (
                        <ul aria-label={t("rooms.listFor", { name: room.name })} className="cal-list flex flex-col gap-1">
                          {room.bookings.map((b) => (
                            <li key={b.start} className="flex items-center justify-between gap-2 text-xs">
                              <span className="truncate text-fg">{b.title ?? t("rooms.private")}</span>
                              <span className="shrink-0 font-mono text-fg-muted tabular-nums">
                                {hhmm(Date.parse(b.start), tz)} {t("calendar.to")} {hhmm(Date.parse(b.end), tz)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="m-0 text-xs text-fg-muted">{t("rooms.free")}</p>
                      )}
                    </section>
                  </div>
                </Panel>
                {data && data.answers.length > 0 && (
                  <Panel title={t("rooms.answers")} description={t("rooms.answersDetail")}>
                    <ul className="cal-list flex flex-col gap-1.5" aria-label={t("rooms.answers")}>
                      {data.answers.slice(0, 8).map((a, i) => (
                        <li key={i} className="flex flex-col text-xs">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-fg">{a.title ?? t("rooms.private")}</span>
                            <StatusBadge tone={a.answer === "accepted" ? "success" : "danger"}>{t(`rooms.${a.answer}One`)}</StatusBadge>
                          </span>
                          <span className="text-fg-muted">
                            {data.rooms.find((r) => r.address === a.room)?.name ?? a.room} · {ago(a.at)} · {a.reason}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
