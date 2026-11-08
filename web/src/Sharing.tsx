import {
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  IconButton,
  PageHeader,
  Panel,
  SelectField,
  Tabs,
  useAgo,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { CheckCircle2, Copy, Download, Link2, Smartphone, Trash2, Upload, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  checkSet,
  jmap,
  type Call,
  type CalendarSession,
  type Device,
  type DirectoryList,
  type EventObj,
  type Leaver,
  type NewDevice,
  type Rights,
  type Subscription,
} from "./api.ts";
import { loadCalendars, setShares, type CalendarEntry } from "./Calendar.tsx";
import { useT, type T } from "./i18n.ts";
import { dayLabel, dateOf } from "./time.ts";

type Access = "busy" | "read" | "edit";
const RIGHTS: Record<Access, Partial<Rights>> = {
  busy: { mayReadFreeBusy: true },
  read: { mayReadFreeBusy: true, mayReadItems: true },
  edit: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayDelete: true },
};
const accessOf = (r: Partial<Rights>): Access => (r.mayWriteAll || r.mayWriteOwn ? "edit" : r.mayReadItems ? "read" : "busy");

interface ShareRow {
  id: string;
  entry: CalendarEntry;
  principalId: string | null;
  who: string;
  access: Access;
  /** Set in the file or by the mail server, not here. */
  fixed: string | null;
}

function CopyField({ label, value, t }: { label: string; value: string; t: T }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg">{label}</span>
      <span className="flex items-center gap-1 rounded-md bg-canvas px-2 py-1.5">
        <code className="min-w-0 grow truncate font-mono text-2xs text-fg">{value}</code>
        <IconButton
          label={t("sharing.copy", { name: label })}
          size="xs"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(value).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <CheckCircle2 className="size-3.5" /> : <Copy className="size-3.5" />}
        </IconButton>
      </span>
      {copied && (
        <span role="status" className="text-2xs text-success">
          {t("sharing.copied", { name: label })}
        </span>
      )}
    </div>
  );
}

const DEVICES = ["apple", "mac", "android", "thunderbird", "outlook"] as const;
type DeviceKind = (typeof DEVICES)[number];

function Steps({ kind, session, t }: { kind: DeviceKind; session: CalendarSession; t: T }) {
  const host = session.dav.server.replace(/^https?:\/\//, "");
  const steps: Record<DeviceKind, ReactNode[]> = {
    apple: [t("devices.apple.1"), t("devices.apple.2"), t("devices.apple.3", { server: host, user: session.address }), t("devices.apple.4")],
    mac: [t("devices.mac.1"), t("devices.mac.2", { server: host, user: session.address }), t("devices.mac.3")],
    android: [
      t("devices.android.1"),
      t("devices.android.2", { url: session.dav.server }),
      t("devices.android.3", { user: session.address }),
      t("devices.android.4"),
    ],
    thunderbird: [
      t("devices.thunderbird.1"),
      t("devices.thunderbird.2", { url: session.dav.calendars }),
      t("devices.thunderbird.3"),
      t("devices.thunderbird.4", { url: session.dav.contacts }),
    ],
    outlook: [t("devices.outlook.1"), t("devices.outlook.2", { url: session.dav.calendars }), t("devices.outlook.3")],
  };
  return (
    <ol className="cal-steps">
      {steps[kind].map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

/** Who sees which calendar, the addresses for calendar apps, links to subscribe to, and meetings to hand over. */
export function SharingPage({ call, session, directory }: { call: Call; session: CalendarSession; directory: DirectoryList }) {
  const t = useT();
  const ago = useAgo();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [calendars, setCalendars] = useState<CalendarEntry[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const [shareCal, setShareCal] = useState("");
  const [shareWith, setShareWith] = useState("");
  const [shareAccess, setShareAccess] = useState<Access>("read");
  const [devices, setDevices] = useState<Device[]>();
  const [made, setMade] = useState<NewDevice>();
  const [deviceKind, setDeviceKind] = useState<DeviceKind>("apple");
  const [links, setLinks] = useState<Subscription[]>();
  const [newLink, setNewLink] = useState<Subscription>();
  const [linkCal, setLinkCal] = useState("");
  const [linkBusy, setLinkBusy] = useState(true);
  const [ioCal, setIoCal] = useState("");
  const [leavers, setLeavers] = useState<Leaver[]>([]);
  const [handing, setHanding] = useState<Leaver | null>(null);
  const [heir, setHeir] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    loadCalendars(call, session, t).then(
      (list) => {
        setCalendars(list);
        const own = list.filter((c) => c.account.kind === "own");
        setShareCal((v) => v || own.find((c) => c.calendar.myRights.mayShare)?.key || "");
        setLinkCal((v) => v || own[0]?.key || "");
        setIoCal((v) => v || list.find((c) => c.calendar.myRights.mayWriteAll)?.key || "");
      },
      (e: Error) => setError(e.message),
    );
    call<{ devices: Device[] }>("/api/v1/devices").then(
      (r) => setDevices(r.devices),
      (e: Error) => setError(e.message),
    );
    call<{ subscriptions: Subscription[] }>("/api/v1/subscriptions").then(
      (r) => setLinks(r.subscriptions),
      () => setLinks([]),
    );
    if (can("admin"))
      call<{ leavers: Leaver[] }>("/api/v1/leavers").then(
        (r) => setLeavers(r.leavers.filter((l) => l.meetings.length)),
        () => {},
      );
  }, [call, session, t, can]);
  useEffect(load, [load]);

  const byPrincipal = new Map(directory.people.map((p) => [p.principalId, p]));
  const rows: ShareRow[] = (calendars ?? []).flatMap((c): ShareRow[] => {
    if (c.account.kind === "team") {
      const team = directory.teams.find((x) => x.address === c.account.address);
      return [
        {
          id: `${c.key}/team`,
          entry: c,
          principalId: null,
          who: t("sharing.teamMembers", { count: team?.members.length ?? 0 }),
          access: "edit",
          fixed: t("sharing.inFile"),
        },
      ];
    }
    if (c.account.kind !== "own") return [];
    const base: ShareRow = { id: `${c.key}/everyone`, entry: c, principalId: null, who: t("sharing.everyone"), access: "busy", fixed: t("sharing.always") };
    return [
      base,
      ...Object.entries(c.calendar.shareWith ?? {}).map(([pid, r]) => ({
        id: `${c.key}/${pid}`,
        entry: c,
        principalId: pid,
        who: byPrincipal.get(pid)?.name ?? pid,
        access: accessOf(r),
        fixed: null,
      })),
    ];
  });
  const sharedWithMe = (calendars ?? []).filter((c) => c.account.kind === "shared");

  async function changeShare(row: ShareRow, access: Access | null) {
    const shares = { ...row.entry.calendar.shareWith };
    if (access) shares[row.principalId!] = RIGHTS[access];
    else delete shares[row.principalId!];
    try {
      await setShares(call, row.entry.account.id, row.entry.calendar.id, shares as Record<string, Partial<Rights>>);
      setNotice(access ? t("sharing.changed", { name: row.who }) : t("sharing.stopped", { name: row.who }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function share() {
    const c = calendars?.find((x) => x.key === shareCal);
    const p = directory.people.find((x) => x.address === shareWith);
    if (!c || !p) return;
    try {
      await setShares(call, c.account.id, c.calendar.id, { ...c.calendar.shareWith, [p.principalId]: RIGHTS[shareAccess] } as Record<string, Partial<Rights>>);
      setSharing(false);
      setNotice(t("sharing.shared", { calendar: c.label, name: p.name }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function makeDevice(name: string) {
    try {
      setMade(await call<NewDevice>("/api/v1/devices", { method: "POST", body: JSON.stringify({ name }) }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function makeLink() {
    const c = calendars?.find((x) => x.key === linkCal);
    if (!c) return;
    try {
      setNewLink(
        await call<Subscription>("/api/v1/subscriptions", {
          method: "POST",
          body: JSON.stringify({ accountId: c.account.id, calendarId: c.calendar.id, busy: linkBusy }),
        }),
      );
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importIcs(f: File) {
    const c = calendars?.find((x) => x.key === ioCal);
    if (!c) return;
    try {
      const up = await call<{ blobId: string }>("/api/v1/upload", { method: "POST", body: f, headers: { "content-type": "text/calendar" } });
      const parsed = await jmap(call, [["CalendarEvent/parse", { accountId: session.accountId, blobIds: [up.blobId] }, "p"]]);
      const list = ((parsed.p!.parsed as Record<string, EventObj[] | null>)?.[up.blobId] ?? []) as Array<EventObj & Record<string, unknown>>;
      if (!list.length) throw new Error(t("io.none"));
      let made = 0;
      // In batches the mail server takes in one call.
      for (let i = 0; i < list.length; i += 200) {
        const create = Object.fromEntries(
          list.slice(i, i + 200).map((e, k) => {
            const { id: _id, iCalendar: _i, calendarIds: _c, ...rest } = e;
            return [`e${k}`, { ...rest, calendarIds: { [c.calendar.id]: true } }];
          }),
        );
        const r = await jmap(call, [["CalendarEvent/set", { accountId: c.account.id, sendSchedulingMessages: false, create }, "s"]]);
        made += Object.keys((r.s!.created as Record<string, unknown> | null) ?? {}).length;
        const refused = Object.values((r.s!.notCreated as Record<string, { description?: string }> | null) ?? {});
        if (refused.length && !made) checkSet(r.s);
      }
      setNotice(t("io.imported", { count: made, total: list.length, calendar: c.label }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handOver(cancel: boolean) {
    if (!handing) return;
    setWorking(true);
    try {
      const r = await call<{ done: number }>(`/api/v1/leavers/${encodeURIComponent(handing.address)}/${cancel ? "cancel" : "handover"}`, {
        method: "POST",
        body: JSON.stringify(cancel ? { ids: chosen } : { to: heir, ids: chosen }),
      });
      setNotice(
        cancel
          ? t("leavers.cancelled", { count: r.done })
          : t("leavers.handed", { count: r.done, name: directory.people.find((p) => p.address === heir)?.name ?? heir }),
      );
      setHanding(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }

  const shareCols: Column<ShareRow>[] = [
    {
      id: "calendar",
      header: t("sharing.calendar"),
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="cal-swatch" style={{ "--cal-hue": r.entry.hue } as CSSProperties} />
          <span className="font-medium">{r.entry.label}</span>
        </span>
      ),
    },
    { id: "with", header: t("sharing.with"), width: "34%", cell: (r) => <span className="truncate">{r.who}</span> },
    {
      id: "access",
      header: t("sharing.theyCan"),
      cell: (r) =>
        r.fixed ? (
          <span className="text-xs text-fg-muted">
            {t(`sharing.access.${r.access}`)}, {r.fixed}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <SelectField
              label={<span className="sr-only">{t("sharing.accessFor", { name: r.who })}</span>}
              value={r.access}
              onChange={(e) => void changeShare(r, e.target.value as Access)}
              options={(["busy", "read", "edit"] as const).map((a) => ({ value: a, label: t(`sharing.access.${a}`) }))}
            />
            <IconButton label={t("sharing.stop", { name: r.who })} size="sm" variant="ghost" onClick={() => void changeShare(r, null)}>
              <Trash2 />
            </IconButton>
          </span>
        ),
    },
  ];

  const own = (calendars ?? []).filter((c) => c.account.kind === "own");
  const io = calendars?.find((c) => c.key === ioCal);

  return (
    <>
      <PageHeader
        title={t("sharing.title")}
        description={t("sharing.description")}
        actions={
          <Button variant="primary" icon={<Users />} onClick={() => setSharing(true)} disabled={!own.some((c) => c.calendar.myRights.mayShare)}>
            {t("sharing.share")}
          </Button>
        }
      />
      {notice && (
        <div role="status" className="cal-gap-below rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
          {notice}
        </div>
      )}
      {error && (
        <Callout tone="danger" title={t("sharing.failed")} onDismiss={() => setError(undefined)} className="cal-gap-below">
          <span className="cal-wrap">{error}</span>
        </Callout>
      )}
      {leavers.map((l) => (
        <Callout
          key={l.address}
          tone="warning"
          title={t("leavers.title", { name: l.name })}
          className="cal-gap-below"
          action={
            <Button size="sm" onClick={() => (setHanding(l), setChosen(l.meetings.map((m) => m.id)), setHeir(""))}>
              {t("leavers.handOver")}
            </Button>
          }
        >
          {t("leavers.detail", { count: l.meetings.length, name: l.name })}
        </Callout>
      ))}
      <div className="cal-side cal-side-wide">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("sharing.who")} flush>
            <DataTable
              label={t("sharing.who")}
              columns={shareCols}
              rows={rows}
              getRowId={(r) => r.id}
              loading={!calendars}
              minWidth={600}
              resizable={false}
              columnMenu={false}
            />
          </Panel>
          {sharedWithMe.length > 0 && (
            <Panel title={t("sharing.withMe")}>
              <ul className="cal-list flex flex-col gap-1.5" aria-label={t("sharing.withMe")}>
                {sharedWithMe.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span aria-hidden className="cal-swatch" style={{ "--cal-hue": c.hue } as CSSProperties} />
                      <span className="truncate">{c.label}</span>
                    </span>
                    <span className="text-xs text-fg-muted">{t(`sharing.access.${accessOf(c.calendar.myRights)}`)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title={t("links.title")} description={t("links.description")}>
            <div className="flex flex-col gap-2.5">
              {links && links.length > 0 && (
                <ul className="cal-list flex flex-col gap-1.5" aria-label={t("links.title")}>
                  {links.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{l.name}</span>
                        <span className="text-2xs text-fg-muted">
                          {l.busy ? t("links.busyOnly") : t("links.full")} · {l.usedAt ? t("links.used", { when: ago(l.usedAt) }) : t("links.unused")}
                        </span>
                      </span>
                      <IconButton
                        label={t("links.remove", { name: l.name })}
                        size="sm"
                        variant="ghost"
                        onClick={() => void call(`/api/v1/subscriptions/${l.id}`, { method: "DELETE" }).then(load, (e: Error) => setError(e.message))}
                      >
                        <Trash2 />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <SelectField
                  label={t("sharing.calendar")}
                  value={linkCal}
                  onChange={(e) => setLinkCal(e.target.value)}
                  options={own.map((c) => ({ value: c.key, label: c.label }))}
                />
                <Checkbox label={t("links.busyOnly")} checked={linkBusy} onChange={(e) => setLinkBusy(e.target.checked)} />
                <Button icon={<Link2 />} onClick={() => void makeLink()} disabled={!linkCal}>
                  {t("links.make")}
                </Button>
              </div>
            </div>
          </Panel>
          <Panel title={t("io.title")} description={t("io.description")}>
            <div className="flex flex-wrap items-end gap-2">
              <SelectField
                label={t("sharing.calendar")}
                value={ioCal}
                onChange={(e) => setIoCal(e.target.value)}
                options={(calendars ?? []).filter((c) => c.calendar.myRights.mayReadItems).map((c) => ({ value: c.key, label: c.label }))}
              />
              {io && (
                <a
                  className="inline-flex"
                  href={`/api/v1/export/calendars/${encodeURIComponent(io.account.id)}/${encodeURIComponent(io.calendar.id)}`}
                  download
                >
                  <Button icon={<Download />} tabIndex={-1}>
                    {t("io.export")}
                  </Button>
                </a>
              )}
              <Button icon={<Upload />} onClick={() => file.current?.click()} disabled={!io?.calendar.myRights.mayWriteAll}>
                {t("io.import")}
              </Button>
              <input
                ref={file}
                type="file"
                accept=".ics,text/calendar"
                className="hidden"
                aria-label={t("io.import")}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importIcs(f);
                  e.target.value = "";
                }}
              />
            </div>
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("apps.title")} description={t("apps.description")}>
            <div className="flex flex-col gap-2.5">
              <CopyField label={t("apps.caldav")} value={session.dav.calendars} t={t} />
              <CopyField label={t("apps.carddav")} value={session.dav.contacts} t={t} />
              <CopyField label={t("apps.username")} value={session.address} t={t} />
              <Tabs
                label={t("apps.device")}
                value={deviceKind}
                onChange={setDeviceKind}
                items={DEVICES.map((d) => ({ value: d, label: t(`devices.${d}.name`) }))}
              />
              <Steps kind={deviceKind} session={session} t={t} />
            </div>
          </Panel>
          <Panel
            title={t("apps.passwords")}
            description={t("apps.passwordsDetail")}
            actions={
              <Button size="sm" icon={<Smartphone />} onClick={() => void makeDevice(t(`devices.${deviceKind}.name`))}>
                {t("apps.make")}
              </Button>
            }
          >
            {devices && devices.length ? (
              <ul className="cal-list flex flex-col gap-1" aria-label={t("apps.passwords")}>
                {devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{d.description}</span>
                    <IconButton
                      label={t("apps.remove", { name: d.description })}
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void call(`/api/v1/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" }).then(load, (e: Error) => setError(e.message))
                      }
                    >
                      <Trash2 />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-fg-muted">{devices ? t("apps.none") : t("calendar.loading")}</p>
            )}
          </Panel>
        </div>
      </div>

      <Dialog
        open={sharing}
        onOpenChange={setSharing}
        title={t("sharing.share")}
        description={t("sharing.shareDetail")}
        onSubmit={(e) => (e.preventDefault(), void share())}
        footer={
          <>
            <Button type="button" onClick={() => setSharing(false)}>
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!shareWith}>
              {t("sharing.share")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2.5">
          <SelectField
            label={t("sharing.calendar")}
            value={shareCal}
            onChange={(e) => setShareCal(e.target.value)}
            options={own.filter((c) => c.calendar.myRights.mayShare).map((c) => ({ value: c.key, label: c.label }))}
          />
          <SelectField
            label={t("sharing.with")}
            value={shareWith}
            onChange={(e) => setShareWith(e.target.value)}
            options={[
              { value: "", label: t("sharing.pick") },
              ...directory.people.filter((p) => p.address !== session.address).map((p) => ({ value: p.address, label: `${p.name} (${p.address})` })),
            ]}
          />
          <SelectField
            label={t("sharing.theyCan")}
            value={shareAccess}
            onChange={(e) => setShareAccess(e.target.value as Access)}
            options={(["busy", "read", "edit"] as const).map((a) => ({ value: a, label: t(`sharing.access.${a}`) }))}
          />
        </div>
      </Dialog>

      <Dialog
        open={!!made}
        onOpenChange={(o) => !o && setMade(undefined)}
        icon={<CheckCircle2 />}
        iconTone="success"
        title={t("apps.made", { name: made?.description ?? "" })}
        description={t("apps.madeDetail")}
        footer={
          <Button variant="primary" onClick={() => setMade(undefined)}>
            {t("dialog.done")}
          </Button>
        }
      >
        {made && (
          <div className="flex flex-col gap-2 text-sm">
            <span className="text-fg-muted">{t("apps.username")}</span>
            <pre className="cal-code">{made.username}</pre>
            <span className="text-fg-muted">{t("apps.password")}</span>
            <pre className="cal-code">{made.secret}</pre>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!newLink}
        onOpenChange={(o) => !o && setNewLink(undefined)}
        icon={<CheckCircle2 />}
        iconTone="success"
        title={t("links.made", { name: newLink?.name ?? "" })}
        description={t("links.madeDetail")}
        footer={
          <Button variant="primary" onClick={() => setNewLink(undefined)}>
            {t("dialog.done")}
          </Button>
        }
      >
        {newLink?.url && <CopyField label={t("links.address")} value={newLink.url} t={t} />}
      </Dialog>

      <Dialog
        open={!!handing}
        onOpenChange={(o) => !o && setHanding(null)}
        title={t("leavers.dialogTitle", { name: handing?.name ?? "" })}
        description={t("leavers.dialogDetail")}
        size="lg"
        onSubmit={(e) => (e.preventDefault(), void handOver(false))}
        footer={
          <>
            <Button type="button" onClick={() => setHanding(null)}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" variant="danger" loading={working} disabled={!chosen.length} onClick={() => void handOver(true)}>
              {t("leavers.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={working} disabled={!heir || !chosen.length}>
              {t("leavers.handOver")}
            </Button>
          </>
        }
      >
        {handing && (
          <div className="flex flex-col gap-2.5">
            <SelectField
              label={t("leavers.to")}
              value={heir}
              onChange={(e) => setHeir(e.target.value)}
              options={[{ value: "", label: t("sharing.pick") }, ...directory.people.map((p) => ({ value: p.address, label: `${p.name} (${p.address})` }))]}
            />
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-1 text-xs font-medium text-fg">{t("leavers.meetings")}</legend>
              {handing.meetings.map((m) => (
                <Checkbox
                  key={m.id}
                  label={m.title || t("event.untitled")}
                  description={`${dayLabel(dateOf(m.start), locale)} ${m.start.slice(11, 16)}${m.timeZone ? ` ${m.timeZone}` : ""}${m.repeats ? ` · ${t("leavers.repeats")}` : ""} · ${t("leavers.guests", { count: m.guests })}`}
                  checked={chosen.includes(m.id)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))}
                />
              ))}
            </fieldset>
          </div>
        )}
      </Dialog>
    </>
  );
}
