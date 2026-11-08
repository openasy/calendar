// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json; calendars and contacts
// follow JMAP for Calendars and Contacts (JSCalendar, RFC 8984, and JSContact, RFC 9553), sent through /api/v1/jmap
// as the signed-in person.
import type { LocalDateTime, RecurrenceRule } from "./time.ts";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface SessionAccount {
  id: string;
  address: string;
  name: string;
  kind: "own" | "team" | "shared";
}

export interface CalendarSession {
  address: string;
  name: string | null;
  accountId: string;
  accounts: SessionAccount[];
  dav: { server: string; calendars: string; contacts: string };
  state: string;
}

export interface Person {
  address: string;
  name: string;
  principalId: string;
  groups: string[];
}

export interface Room {
  address: string;
  name: string;
  kind: "room" | "equipment";
  seats: number | null;
  location: string | null;
  features: string[];
  bookers: string[];
  bookAhead: number;
  principalId?: string | null;
}

export interface Team {
  address: string;
  name: string;
  members: string[];
  principalId?: string | null;
}

export interface DirectoryList {
  source: "identity" | "mail-server";
  people: Person[];
  rooms: Room[];
  teams: Team[];
}

export interface Busy {
  start: string;
  end: string;
  status: string;
}

export interface Availability {
  from: string;
  to: string;
  busy: Record<string, Busy[] | null>;
}

export interface RoomBooking {
  start: string;
  end: string;
  title: string | null;
  organizer: string | null;
  organizerName: string | null;
  mine: boolean;
}

export interface RoomAnswer {
  at: string;
  room: string;
  title: string | null;
  organizer: string | null;
  answer: "accepted" | "declined";
  reason: string;
}

export interface RoomDay {
  from: string;
  to: string;
  rooms: Array<Room & { bookings: RoomBooking[]; unavailable: boolean }>;
  lastWeek: { accepted: number; declined: number };
  answers: RoomAnswer[];
}

export type ConfigFile = { path: string; appliedAt: string | null; teams: number; rooms: number; error: string | null; text: string | null } | null;

export interface SyncResult {
  at: string;
  ok: boolean;
  created: string[];
  updated: string[];
  disabled: string[];
  warnings: string[];
  error: string | null;
}

export interface ConfigView {
  teams: Team[];
  rooms: Room[];
  file: ConfigFile;
}

export interface Summary {
  teams: number;
  rooms: number;
  file: ConfigFile;
  sync: SyncResult | null;
  davUrl: string;
}

export interface Device {
  id: string;
  description: string;
  createdAt?: string;
}

export interface NewDevice extends Device {
  secret: string;
  username: string;
}

export interface Subscription {
  id: string;
  accountId: string;
  calendarId: string;
  name: string;
  busy: boolean;
  createdAt: string;
  usedAt: string | null;
  url?: string;
}

export interface Leaver {
  address: string;
  name: string;
  meetings: Array<{ id: string; title: string; start: string; timeZone: string | null; repeats: boolean; guests: number }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`, problem.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

// JMAP objects, with only the properties the pages use.

export interface Rights {
  mayReadFreeBusy: boolean;
  mayReadItems: boolean;
  mayWriteAll: boolean;
  mayWriteOwn: boolean;
  mayUpdatePrivate: boolean;
  mayRSVP: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

export interface CalendarObj {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  isVisible: boolean;
  shareWith: Record<string, Partial<Rights>> | null;
  myRights: Rights;
}

export type Answer = "accepted" | "tentative" | "declined" | "needs-action" | "delegated";

export interface Participant {
  "@type"?: "Participant";
  name?: string;
  calendarAddress?: string;
  kind?: "individual" | "group" | "location" | "resource";
  roles?: Record<string, boolean>;
  participationStatus?: Answer;
  expectReply?: boolean;
}

export interface Alert {
  "@type"?: "Alert";
  trigger: { "@type": "OffsetTrigger"; offset: string; relativeTo?: "start" | "end" };
  action?: "display" | "email";
}

export interface EventData {
  "@type"?: "Event";
  uid?: string;
  title?: string;
  description?: string;
  start: LocalDateTime;
  timeZone?: string | null;
  duration?: string;
  showWithoutTime?: boolean;
  status?: "confirmed" | "tentative" | "cancelled";
  freeBusyStatus?: "busy" | "free";
  privacy?: "public" | "private" | "secret";
  locations?: Record<string, { "@type"?: "Location"; name: string }> | null;
  participants?: Record<string, Participant> | null;
  organizerCalendarAddress?: string | null;
  recurrenceRule?: RecurrenceRule | null;
  recurrenceOverrides?: Record<LocalDateTime, Partial<EventData> & { excluded?: boolean }> | null;
  alerts?: Record<string, Alert> | null;
  calendarIds?: Record<string, boolean>;
}

/** One event as the mail server sends it: a single event, a series, or one time of a series. */
export interface EventObj extends EventData {
  id: string;
  baseEventId?: string | null;
  recurrenceId?: LocalDateTime | null;
  utcStart?: string;
  utcEnd?: string;
}

export interface AddressBookObj {
  id: string;
  name: string;
  isDefault: boolean;
  myRights: { mayRead: boolean; mayWrite: boolean; mayDelete: boolean; mayShare: boolean };
}

export interface CardObj {
  id: string;
  uid?: string;
  kind?: "individual" | "group" | "org";
  addressBookIds: Record<string, boolean>;
  name?: { full?: string; components?: Array<{ kind: string; value: string }> };
  emails?: Record<string, { address: string }>;
  phones?: Record<string, { number: string }>;
  organizations?: Record<string, { name: string }>;
  titles?: Record<string, { name: string }>;
  notes?: Record<string, { note: string }>;
  members?: Record<string, boolean>;
}

export type Invocation = [string, Record<string, unknown>, string];

export const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:calendars",
  "urn:ietf:params:jmap:calendars:parse",
  "urn:ietf:params:jmap:contacts",
  "urn:ietf:params:jmap:contacts:parse",
];

/** One JMAP request; throws when any method answered with an error, naming it. Answers by call id. */
export async function jmap(call: Call, methodCalls: Invocation[]): Promise<Record<string, Record<string, any>>> {
  const r = await call<{ methodResponses: Invocation[] }>("/api/v1/jmap", {
    method: "POST",
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  const out: Record<string, Record<string, any>> = {};
  for (const [name, args, id] of r.methodResponses) {
    if (name === "error") throw new ApiError(`${String(args.type)}${args.description ? `: ${String(args.description)}` : ""}`, "jmap");
    out[id] = args;
  }
  return out;
}

/** Throws with the mail server's reason when a /set did not create, update or destroy something. */
export function checkSet(r: Record<string, any> | undefined) {
  for (const k of ["notCreated", "notUpdated", "notDestroyed"]) {
    const failed = Object.values((r?.[k] ?? {}) as Record<string, { type?: string; description?: string; properties?: string[] }>);
    if (failed.length) throw new ApiError(failed.map((e) => e.description ?? e.type ?? "refused").join("; "), "jmap");
  }
}
