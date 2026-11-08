import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  PageHeader,
  Panel,
  SearchInput,
  SelectField,
  Tabs,
  TextField,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { CalendarDays, Download, Mail, Pencil, Plus, Trash2, Upload, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkSet, jmap, type AddressBookObj, type Call, type CalendarSession, type CardObj, type DirectoryList } from "./api.ts";
import type { Guest } from "./events.ts";
import { loadEvents } from "./events.ts";
import { useT, type T } from "./i18n.ts";
import { dateOf, dayLabel, hhmm, toLocal } from "./time.ts";
import { useTimeZone } from "./Calendar.tsx";

interface Book {
  /** accountId/addressBookId, or "directory". */
  key: string;
  accountId: string | null;
  id: string | null;
  name: string;
  writable: boolean;
}

interface Row {
  key: string;
  book: string;
  card: CardObj | null;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  group: boolean;
}

const first = <V,>(m: Record<string, V> | undefined) => (m ? Object.values(m)[0] : undefined);

function rowOf(card: CardObj, book: string): Row {
  return {
    key: `${book}/${card.id}`,
    book,
    card,
    name: card.name?.full || card.name?.components?.map((c) => c.value).join(" ") || first(card.emails)?.address || "",
    title: first(card.titles)?.name ?? "",
    company: first(card.organizations)?.name ?? "",
    email: first(card.emails)?.address ?? "",
    phone: first(card.phones)?.number ?? "",
    group: card.kind === "group",
  };
}

interface ContactForm {
  name: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  note: string;
  book: string;
}

function ContactDialog({
  open,
  books,
  initial,
  onClose,
  onSave,
  t,
}: {
  open: boolean;
  books: Book[];
  initial: ContactForm;
  onClose: () => void;
  onSave: (f: ContactForm) => Promise<void>;
  t: T;
}) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setF(initial), [initial]);
  const set = (k: keyof ContactForm, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={initial.name ? t("contacts.editTitle") : t("contacts.newTitle")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!f.name.trim() && !f.email.trim()) return setError(t("contacts.needName"));
        setBusy(true);
        try {
          await onSave(f);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t("dialog.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <p className="m-0 text-sm text-danger">{error}</p>}
        <TextField label={t("contacts.name")} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={200} />
        <div className="grid grid-cols-2 gap-2">
          <TextField label={t("contacts.email")} type="email" value={f.email} onChange={(e) => set("email", e.target.value)} maxLength={254} />
          <TextField label={t("contacts.phone")} type="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} maxLength={64} />
          <TextField label={t("contacts.company")} value={f.company} onChange={(e) => set("company", e.target.value)} maxLength={200} />
          <TextField label={t("contacts.jobTitle")} value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={200} />
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium text-fg">
          {t("contacts.note")}
          <textarea className="cal-textarea" value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={5000} />
        </label>
        {!initial.name && (
          <SelectField
            label={t("contacts.book")}
            value={f.book}
            onChange={(e) => set("book", e.target.value)}
            options={books.filter((b) => b.writable).map((b) => ({ value: b.key, label: b.name }))}
          />
        )}
      </div>
    </Dialog>
  );
}

/** The company directory, a person's own contacts and the address books their teams share. */
export function ContactsPage({
  call,
  session,
  directory,
  onInvite,
}: {
  call: Call;
  session: CalendarSession;
  directory: DirectoryList;
  onInvite: (guests: Guest[]) => void;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [tz] = useTimeZone();
  const [books, setBooks] = useState<Book[]>([]);
  const [cards, setCards] = useState<Row[]>();
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: Row | null } | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [importTo, setImportTo] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const found: Book[] = [];
      const rows: Row[] = [];
      await Promise.all(
        session.accounts.map(async (a) => {
          const r = await jmap(call, [
            ["AddressBook/get", { accountId: a.id }, "b"],
            ["ContactCard/query", { accountId: a.id, limit: 2000 }, "q"],
            ["ContactCard/get", { accountId: a.id, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "c"],
          ]).catch(() => null);
          if (!r) return;
          for (const b of (r.b!.list ?? []) as AddressBookObj[]) {
            const name =
              a.kind === "own"
                ? b.isDefault
                  ? t("contacts.mine")
                  : b.name
                : a.kind === "team"
                  ? b.isDefault
                    ? a.name
                    : `${b.name} (${a.name})`
                  : `${b.isDefault ? a.name : b.name} (${t("contacts.shared")})`;
            found.push({ key: `${a.id}/${b.id}`, accountId: a.id, id: b.id, name, writable: b.myRights.mayWrite });
          }
          for (const c of (r.c!.list ?? []) as CardObj[]) {
            const bookId = Object.keys(c.addressBookIds ?? {})[0];
            if (bookId) rows.push(rowOf(c, `${a.id}/${bookId}`));
          }
        }),
      );
      const order = (k: string) => session.accounts.findIndex((a) => k.startsWith(`${a.id}/`));
      found.sort((x, y) => order(x.key) - order(y.key));
      setBooks(found);
      setCards(rows);
      setImportTo((v) => v || found.find((b) => b.writable)?.key || "");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [call, session, t]);
  useEffect(() => void load(), [load]);

  const dir: Row[] = useMemo(
    () =>
      directory.people.map((p) => ({
        key: `directory/${p.address}`,
        book: "directory",
        card: null,
        name: p.name,
        title: p.groups.join(", "),
        company: "",
        email: p.address,
        phone: "",
        group: false,
      })),
    [directory.people],
  );
  const all = [...dir, ...(cards ?? [])];
  const groups = all.filter((r) => r.group);
  const groupFilter = tab.startsWith("group:") ? groups.find((g) => g.key === tab.slice(6)) : undefined;
  const rows = all.filter((r) => {
    if (groupFilter) return !r.group && !!r.card?.uid && !!groupFilter.card?.members?.[r.card.uid];
    if (tab !== "all" && r.book !== tab) return false;
    return `${r.name} ${r.company} ${r.email}`.toLowerCase().includes(query.toLowerCase());
  });
  const cur = all.find((r) => r.key === active) ?? rows[0];

  // The next meeting with them, from the person's own calendars.
  useEffect(() => {
    setNext(undefined);
    if (!cur?.email) return setNext(null);
    let live = true;
    const start = Date.now();
    jmap(call, [["Calendar/get", { accountId: session.accountId, properties: ["id"] }, "c"]])
      .then((r) =>
        loadEvents(
          call,
          [{ accountId: session.accountId, calendarIds: (r.c!.list as Array<{ id: string }>).map((c) => c.id) }],
          start,
          start + 90 * 86_400_000,
          session.address,
          tz,
        ),
      )
      .then((list) => {
        const hit = list.find((e) =>
          Object.values(e.event.participants ?? {}).some((p) => (p.calendarAddress ?? "").toLowerCase() === `mailto:${cur.email.toLowerCase()}`),
        );
        if (live)
          setNext(hit ? `${dayLabel(dateOf(toLocal(hit.start, tz)), locale)} ${hit.allDay ? "" : hhmm(hit.start, tz)} ${hit.event.title ?? ""}`.trim() : null);
      })
      .catch(() => live && setNext(null));
    return () => {
      live = false;
    };
  }, [call, cur?.email, session, tz, locale]);

  const bookName = (key: string) => (key === "directory" ? t("contacts.directory") : (books.find((b) => b.key === key)?.name ?? ""));
  const cols: Column<Row>[] = [
    {
      id: "name",
      header: t("contacts.name"),
      width: "32%",
      sortValue: (r) => r.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={r.name || "?"} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{r.name}</span>
            <span className="truncate text-2xs text-fg-muted">
              {r.group ? t("contacts.groupOf", { count: Object.keys(r.card?.members ?? {}).length }) : r.title}
            </span>
          </span>
        </span>
      ),
    },
    { id: "company", header: t("contacts.company"), sortValue: (r) => r.company, cell: (r) => <span className="truncate text-xs">{r.company || "–"}</span> },
    { id: "email", header: t("contacts.email"), width: "28%", cell: (r) => <span className="block truncate font-mono text-xs">{r.email}</span> },
    { id: "book", header: t("contacts.book"), cell: (r) => <Badge tone={r.book === "directory" ? "info" : "neutral"}>{bookName(r.book)}</Badge> },
  ];

  async function saveContact(f: ContactForm) {
    const row = editing?.row;
    const [accountId, bookId] = (row ? row.book : f.book).split("/") as [string, string];
    const card: Record<string, unknown> = {
      "@type": "Card",
      version: "1.0",
      kind: "individual",
      name: { full: f.name.trim() || f.email.trim() },
      emails: f.email.trim() ? { e1: { address: f.email.trim() } } : null,
      phones: f.phone.trim() ? { p1: { number: f.phone.trim() } } : null,
      organizations: f.company.trim() ? { o1: { name: f.company.trim() } } : null,
      titles: f.title.trim() ? { t1: { name: f.title.trim() } } : null,
      notes: f.note.trim() ? { n1: { note: f.note.trim() } } : null,
    };
    const r = row?.card
      ? await jmap(call, [["ContactCard/set", { accountId, update: { [row.card.id]: card } }, "s"]])
      : await jmap(call, [
          ["ContactCard/set", { accountId, create: { c: { ...card, uid: `urn:uuid:${crypto.randomUUID()}`, addressBookIds: { [bookId]: true } } } }, "s"],
        ]);
    checkSet(r.s);
    setEditing(null);
    setNotice(t("contacts.saved", { name: f.name || f.email }));
    await load();
  }

  async function remove(row: Row) {
    if (!row.card) return;
    const [accountId] = row.book.split("/") as [string];
    try {
      checkSet((await jmap(call, [["ContactCard/set", { accountId, destroy: [row.card.id] }, "s"]])).s);
      setActive(null);
      setNotice(t("contacts.deleted", { name: row.name }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function makeGroup() {
    const book = books.find((b) => b.key === importTo && b.writable) ?? books.find((b) => b.writable);
    if (!book || !groupName.trim()) return;
    try {
      // A group names its members by their uid; contacts without one get one first.
      const chosen = (cards ?? []).filter((r) => members.includes(r.key) && r.card);
      const needUid = chosen.filter((r) => !r.card!.uid);
      for (const r of needUid) {
        const [acc] = r.book.split("/") as [string];
        const uid = `urn:uuid:${crypto.randomUUID()}`;
        checkSet((await jmap(call, [["ContactCard/set", { accountId: acc, update: { [r.card!.id]: { uid } } }, "s"]])).s);
        r.card!.uid = uid;
      }
      const r = await jmap(call, [
        [
          "ContactCard/set",
          {
            accountId: book.accountId,
            create: {
              g: {
                "@type": "Card",
                version: "1.0",
                kind: "group",
                uid: `urn:uuid:${crypto.randomUUID()}`,
                name: { full: groupName.trim() },
                addressBookIds: { [book.id!]: true },
                members: Object.fromEntries(chosen.map((c) => [c.card!.uid!, true])),
              },
            },
          },
          "s",
        ],
      ]);
      checkSet(r.s);
      setGrouping(false);
      setGroupName("");
      setMembers([]);
      setNotice(t("contacts.groupMade", { name: groupName.trim() }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importFile(f: File) {
    const book = books.find((b) => b.key === importTo);
    if (!book?.accountId) return;
    try {
      const up = await call<{ blobId: string }>("/api/v1/upload", { method: "POST", body: f, headers: { "content-type": "text/vcard" } });
      const parsed = await jmap(call, [["ContactCard/parse", { accountId: session.accountId, blobIds: [up.blobId] }, "p"]]);
      const list = ((parsed.p!.parsed as Record<string, CardObj[] | null>)?.[up.blobId] ?? []) as Array<CardObj & Record<string, unknown>>;
      if (!list.length) throw new Error(t("contacts.importNone"));
      const create = Object.fromEntries(
        list.map((c, i) => {
          const { id: _id, addressBookIds: _b, vCard: _v, ...rest } = c;
          return [`c${i}`, { ...rest, addressBookIds: { [book.id!]: true } }];
        }),
      );
      const r = await jmap(call, [["ContactCard/set", { accountId: book.accountId, create }, "s"]]);
      const made = Object.keys((r.s!.created as Record<string, unknown> | null) ?? {}).length;
      setNotice(t("contacts.imported", { count: made, book: book.name }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const initial: ContactForm = editing?.row
    ? {
        name: editing.row.name,
        email: editing.row.email,
        phone: editing.row.phone,
        company: editing.row.company,
        title: editing.row.title,
        note: first(editing.row.card?.notes)?.note ?? "",
        book: editing.row.book,
      }
    : { name: "", email: "", phone: "", company: "", title: "", note: "", book: books.find((b) => b.writable)?.key ?? "" };
  const exportable = books.find((b) => b.key === tab) ?? books.find((b) => b.key === importTo);

  return (
    <>
      <PageHeader
        title={t("contacts.title")}
        description={directory.source === "identity" ? t("contacts.descriptionIdentity") : t("contacts.description")}
        actions={
          <>
            <Button icon={<Upload />} onClick={() => file.current?.click()} disabled={!books.some((b) => b.writable)}>
              {t("contacts.import")}
            </Button>
            <Button icon={<Users />} onClick={() => setGrouping(true)} disabled={!books.some((b) => b.writable)}>
              {t("contacts.newGroup")}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ row: null })} disabled={!books.some((b) => b.writable)}>
              {t("contacts.new")}
            </Button>
          </>
        }
      />
      <input
        ref={file}
        type="file"
        accept=".vcf,text/vcard"
        className="hidden"
        aria-label={t("contacts.import")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = "";
        }}
      />
      {notice && (
        <div role="status" className="cal-gap-below rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
          {notice}
        </div>
      )}
      {error && (
        <Callout tone="danger" title={t("contacts.failed")} onDismiss={() => setError(undefined)} className="cal-gap-below">
          {error}
        </Callout>
      )}
      <div className="cal-side">
        <Panel flush>
          <div className="flex flex-wrap items-end justify-between gap-2 px-3 pt-2">
            <Tabs
              label={t("contacts.book")}
              value={tab}
              onChange={(v) => (setTab(v), setActive(null))}
              items={[
                { value: "all", label: t("contacts.all"), count: all.length },
                { value: "directory", label: t("contacts.directory"), count: dir.length },
                ...books.map((b) => ({ value: b.key, label: b.name, count: (cards ?? []).filter((r) => r.book === b.key).length })),
                ...groups.map((g) => ({ value: `group:${g.key}`, label: g.name, count: Object.keys(g.card?.members ?? {}).length })),
              ]}
              className="border-b-0"
            />
            <SearchInput
              label={t("contacts.search")}
              placeholder={t("contacts.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mb-1.5 w-56"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("contacts.title")}
              columns={cols}
              rows={rows}
              getRowId={(r) => r.key}
              onRowClick={(r) => setActive(r.key)}
              activeRowId={cur?.key}
              defaultSort={{ id: "name", direction: "asc" }}
              loading={!cards}
              empty={t("contacts.none")}
              minWidth={640}
              pageSize={50}
            />
          </div>
        </Panel>
        <div className="flex flex-col gap-2.5">
          {cur && (
            <Panel aria-label={t("contacts.contact")}>
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex items-center gap-2.5">
                  <Avatar name={cur.name || "?"} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-base font-semibold text-fg">{cur.name}</span>
                    <span className="truncate text-xs text-fg-muted">{[cur.title, cur.company].filter(Boolean).join(" · ")}</span>
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {cur.email && (
                    <a href={`mailto:${cur.email}`} className="inline-flex">
                      <Button size="sm" icon={<Mail />} tabIndex={-1}>
                        {t("contacts.write")}
                      </Button>
                    </a>
                  )}
                  {(cur.email || cur.group) && (
                    <Button
                      size="sm"
                      icon={<CalendarDays />}
                      onClick={() =>
                        onInvite(
                          cur.group
                            ? (cards ?? [])
                                .filter((r) => r.card?.uid && cur.card?.members?.[r.card.uid] && r.email)
                                .map((r) => ({ email: r.email, name: r.name }))
                            : [{ email: cur.email, name: cur.name }],
                        )
                      }
                    >
                      {t("contacts.invite")}
                    </Button>
                  )}
                  {cur.card && books.find((b) => b.key === cur.book)?.writable && (
                    <>
                      {!cur.group && (
                        <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing({ row: cur })}>
                          {t("event.edit")}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => void remove(cur)}>
                        {t("event.delete")}
                      </Button>
                    </>
                  )}
                </div>
                <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
                  {cur.email && (
                    <>
                      <dt className="text-fg-muted">{t("contacts.email")}</dt>
                      <dd className="m-0 truncate font-mono text-fg">{cur.email}</dd>
                    </>
                  )}
                  {cur.phone && (
                    <>
                      <dt className="text-fg-muted">{t("contacts.phone")}</dt>
                      <dd className="m-0 font-mono text-fg">{cur.phone}</dd>
                    </>
                  )}
                  <dt className="text-fg-muted">{t("contacts.book")}</dt>
                  <dd className="m-0 text-fg">{bookName(cur.book)}</dd>
                </dl>
                {first(cur.card?.notes)?.note && (
                  <p className="m-0 whitespace-pre-wrap rounded-md bg-canvas px-2.5 py-2 text-xs">{first(cur.card?.notes)!.note}</p>
                )}
                {!cur.group && (
                  <section className="flex flex-col gap-1 border-t border-line pt-3">
                    <h2 className="m-0 text-xs font-semibold text-fg-muted">{t("contacts.next")}</h2>
                    <p className="m-0 text-xs text-fg">{next === undefined ? t("calendar.loading") : (next ?? t("contacts.noneNext"))}</p>
                  </section>
                )}
              </div>
            </Panel>
          )}
          <Panel title={t("contacts.files")} description={t("contacts.filesDetail")}>
            <div className="flex flex-col gap-2">
              <SelectField
                label={t("contacts.importInto")}
                value={importTo}
                onChange={(e) => setImportTo(e.target.value)}
                options={books.filter((b) => b.writable).map((b) => ({ value: b.key, label: b.name }))}
              />
              {exportable && (
                <a
                  className="inline-flex self-start"
                  href={`/api/v1/export/addressbooks/${encodeURIComponent(exportable.accountId!)}/${encodeURIComponent(exportable.id!)}`}
                  download
                >
                  <Button size="sm" icon={<Download />} tabIndex={-1}>
                    {t("contacts.export", { name: exportable.name })}
                  </Button>
                </a>
              )}
            </div>
          </Panel>
        </div>
      </div>
      <ContactDialog open={!!editing} books={books} initial={initial} onClose={() => setEditing(null)} onSave={saveContact} t={t} />
      <Dialog
        open={grouping}
        onOpenChange={setGrouping}
        title={t("contacts.newGroup")}
        description={t("contacts.groupDetail")}
        onSubmit={(e) => (e.preventDefault(), void makeGroup())}
        footer={
          <>
            <Button type="button" onClick={() => setGrouping(false)}>
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!groupName.trim()}>
              {t("dialog.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2.5">
          <TextField label={t("contacts.groupName")} value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={200} />
          <SelectField
            label={t("contacts.book")}
            value={importTo}
            onChange={(e) => setImportTo(e.target.value)}
            options={books.filter((b) => b.writable).map((b) => ({ value: b.key, label: b.name }))}
          />
          <fieldset className="m-0 flex flex-col gap-1 overflow-y-auto border-0 p-0" style={{ maxHeight: "16rem" }}>
            <legend className="mb-1 text-xs font-medium text-fg">{t("contacts.members")}</legend>
            {(cards ?? [])
              .filter((r) => !r.group)
              .map((r) => (
                <Checkbox
                  key={r.key}
                  label={r.name}
                  description={r.email}
                  checked={members.includes(r.key)}
                  onChange={(e) => setMembers((m) => (e.target.checked ? [...m, r.key] : m.filter((x) => x !== r.key)))}
                />
              ))}
          </fieldset>
        </div>
      </Dialog>
    </>
  );
}
