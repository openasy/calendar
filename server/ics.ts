// iCalendar (RFC 5545) and vCard (RFC 6350) files from what Stalwart's CalDAV and CardDAV answer: every event of a
// calendar in one .ics file, and, for a subscription link that shows only free and busy, the same events with nothing
// but their times. Stalwart writes the iCalendar itself; this only joins and trims it.

/** The calendar-data or address-data of each response in a WebDAV Multi-Status answer. */
export function davData(multistatus: string, element: "calendar-data" | "address-data"): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${element}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</(?:[A-Za-z0-9]+:)?${element}>`, "g");
  return [...multistatus.matchAll(re)].map((m) => m[1] ?? unescapeXml(m[2] ?? "")).filter((s) => s.trim());
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (all, name: string, dec?: string, hex?: string) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? all;
  });

/** Content lines with folding undone (RFC 5545 3.1). */
export function unfold(text: string): string[] {
  return text
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}

/** Folds a line at 75 octets without splitting a character. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off to the start of a UTF-8 character.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

const nameOf = (line: string) => line.slice(0, line.search(/[;:]/)).toUpperCase();

interface Component {
  name: string;
  lines: string[];
}

/** The top-level components inside each VCALENDAR: VTIMEZONE, VEVENT, VTODO, with their nested ones. */
function components(doc: string): Component[] {
  const out: Component[] = [];
  let current: Component | null = null;
  let depth = 0;
  for (const line of unfold(doc)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      depth++;
      if (depth === 2) current = { name: upper.slice(6), lines: [] };
    }
    if (current) current.lines.push(line);
    if (upper.startsWith("END:")) {
      if (depth === 2 && current) (out.push(current), (current = null));
      depth--;
    }
  }
  return out;
}

/** Times and recurrence only: what a busy-only subscriber may see of an event. */
const BUSY_KEEP = new Set(["DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "UID", "DTSTAMP", "SEQUENCE", "STATUS"]);

function busyOnly(c: Component, label: string): Component | null {
  const props = c.lines.slice(1, -1);
  if (props.some((l) => l.toUpperCase() === "TRANSP:TRANSPARENT" || l.toUpperCase() === "STATUS:CANCELLED")) return null;
  const kept: string[] = [];
  let nested = 0;
  for (const l of props) {
    const upper = l.toUpperCase();
    if (upper.startsWith("BEGIN:")) nested++;
    if (nested === 0 && BUSY_KEEP.has(nameOf(l))) kept.push(l);
    if (upper.startsWith("END:")) nested--;
  }
  return { name: c.name, lines: [c.lines[0]!, ...kept, `SUMMARY:${escapeText(label)}`, "CLASS:PRIVATE", c.lines.at(-1)!] };
}

export const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/**
 * One VCALENDAR from many: each time zone once, then every event. With `busy`, events keep only their times and are
 * all called by that label.
 */
export function joinCalendars(docs: string[], { name, busy }: { name: string; busy?: string }): string {
  const zones = new Map<string, Component>();
  const items: Component[] = [];
  for (const doc of docs)
    for (const c of components(doc)) {
      if (c.name === "VTIMEZONE") {
        const tzid = c.lines.find((l) => nameOf(l) === "TZID")?.split(":")[1] ?? "";
        if (!zones.has(tzid)) zones.set(tzid, c);
      } else if (c.name === "VEVENT" || c.name === "VTODO") {
        const kept = busy ? (c.name === "VEVENT" ? busyOnly(c, busy) : null) : c;
        if (kept) items.push(kept);
      }
    }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenAsy//Calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(name)}`,
    ...[...zones.values()].flatMap((z) => z.lines),
    ...items.flatMap((i) => i.lines),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Every vCard in one file, as address books export them. */
export function joinCards(cards: string[]): string {
  return cards.map((c) => unfold(c).map(fold).join("\r\n")).join("\r\n") + (cards.length ? "\r\n" : "");
}

/** A REPORT body asking a calendar for every event with its iCalendar data. */
export const CALENDAR_QUERY = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"/></c:filter></c:calendar-query>`;
/** A REPORT body asking an address book for every card. */
export const ADDRESSBOOK_QUERY = `<?xml version="1.0" encoding="utf-8"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><c:address-data/></d:prop></c:addressbook-query>`;
/** A PROPFIND body for each collection's name. */
export const DISPLAY_NAMES = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`;

/** The collections a PROPFIND answered, by their name: href and display name. */
export function collections(multistatus: string): Array<{ href: string; name: string }> {
  const out: Array<{ href: string; name: string }> = [];
  for (const m of multistatus.matchAll(/<(?:[A-Za-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?response>/g)) {
    const body = m[1]!;
    const href = /<(?:[A-Za-z0-9]+:)?href>([^<]+)</.exec(body)?.[1];
    const name = /<(?:[A-Za-z0-9]+:)?displayname>([^<]*)</.exec(body)?.[1];
    if (href && name !== undefined && /(calendar|addressbook)\s*\/>/.test(body)) out.push({ href, name: unescapeXml(name) });
  }
  return out;
}
