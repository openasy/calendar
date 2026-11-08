// Makes the mail server match the file: each team is a group account whose members are the team's mailboxes, and each
// room is an account that only takes invitations. Calendar marks the accounts it makes (externalId) and touches only
// those, and only the team memberships it gave; Mail's mailboxes and anything an admin made on the server stay as
// they are. Mail leaves both kinds alone: it only manages accounts of type User with the User role, and a team is a
// group while a room has Calendar's own role. A room or team taken out of the file is not deleted, so its bookings and
// calendar stay: a room stops taking invitations, and a team loses its members.
import type { Room, Team, CalendarConfig } from "./config.ts";
import { CALENDARS, CONTACTS, CORE, StalwartError, type Stalwart, type StalwartAccount } from "./stalwart.ts";

export const ROOM_MARK = "openasy-calendar:room";
export const TEAM_MARK = "openasy-calendar:team";
export const ROOM_ROLE = "OpenAsy Calendar room";

/**
 * What a room's account may do: be acted as by Calendar (authenticate, though it has no password), receive invitations
 * (emailReceive and calendarSchedulingReceive) and answer them; never send mail or read anything but its calendar.
 */
export const ROOM_PERMISSIONS = [
  "authenticate",
  "emailReceive",
  "calendarSchedulingSend",
  "calendarSchedulingReceive",
  "jmapCoreEcho",
  "jmapPrincipalGet",
  "jmapPrincipalQuery",
  "jmapPrincipalGetAvailability",
  "jmapCalendarGet",
  "jmapCalendarChanges",
  "jmapCalendarUpdate",
  "jmapCalendarEventGet",
  "jmapCalendarEventChanges",
  "jmapCalendarEventQuery",
  "jmapCalendarEventQueryChanges",
  "jmapCalendarEventUpdate",
  "jmapCalendarEventNotificationGet",
  "jmapCalendarEventNotificationChanges",
  "jmapCalendarEventNotificationQuery",
  "jmapCalendarEventNotificationDestroy",
  "jmapParticipantIdentityGet",
];

/** What a room taken out of the file may no longer do. */
const ROOM_DISABLED = { authenticate: true, emailReceive: true, calendarSchedulingReceive: true };

export interface SyncResult {
  at: string;
  ok: boolean;
  created: string[];
  updated: string[];
  /** Rooms that stopped taking invitations and teams that lost their members, because they left the file. */
  disabled: string[];
  /** What the file names that the mail server does not have, such as a member without a mailbox. */
  warnings: string[];
  error: string | null;
}

const localPart = (addr: string) => addr.slice(0, addr.lastIndexOf("@"));
const domainPart = (addr: string) => addr.slice(addr.lastIndexOf("@") + 1);

/** An account's address: Stalwart's emailAddress, or its name in its domain. */
export function addressOf(a: StalwartAccount, domainNames: Map<string, string>): string {
  return (a.emailAddress ?? `${a.name}@${domainNames.get(a.domainId) ?? ""}`).toLowerCase();
}

export const isDisabled = (a: StalwartAccount) => a.permissions?.["@type"] === "Merge" && a.permissions.disabledPermissions?.authenticate === true;
export const isOurs = (a: StalwartAccount) => a.externalId === ROOM_MARK || a.externalId === TEAM_MARK;

const sameSet = (a: Record<string, boolean> | null | undefined, b: Set<string>) => {
  const keys = Object.keys(a ?? {}).filter((k) => a![k]);
  return keys.length === b.size && keys.every((k) => b.has(k));
};

/** The role rooms have, made or put right. */
async function roomRole(stalwart: Stalwart): Promise<string> {
  const want = Object.fromEntries(ROOM_PERMISSIONS.map((p) => [p, true]));
  const have = (await stalwart.roles()).find((r) => r.description === ROOM_ROLE);
  if (have && sameSet(have.enabledPermissions, new Set(ROOM_PERMISSIONS))) return have.id;
  return stalwart.setRole(have?.id ?? null, { description: ROOM_ROLE, enabledPermissions: want });
}

/** Names the default calendar (and for a team, its address book) after the room or team, as calendar apps show it. */
async function nameCollections(stalwart: Stalwart, kind: "room" | "team", address: string, accountId: string, name: string) {
  const calls = [
    ["Calendar/get", { accountId, properties: ["name", "isDefault"] }, "c"],
    ...(kind === "team" ? [["AddressBook/get", { accountId, properties: ["name", "isDefault"] }, "a"]] : []),
  ] as Array<[string, Record<string, unknown>, string]>;
  const using = [CORE, CALENDARS, CONTACTS];
  // A room acts as itself; a team's account cannot, so the service account names its calendar.
  const run = (methodCalls: Array<[string, Record<string, unknown>, string]>) =>
    kind === "room" ? stalwart.call(address, { using, methodCalls }) : stalwart.callAsService({ using, methodCalls });
  const r = await run(calls);
  const updates: Array<[string, Record<string, unknown>, string]> = [];
  for (const [method, args] of r.methodResponses) {
    if (method === "error") continue;
    const list = (args.list ?? []) as Array<{ id: string; name: string; isDefault?: boolean }>;
    const main = list.find((c) => c.isDefault) ?? list[0];
    if (main && main.name !== name) updates.push([method.replace("/get", "/set"), { accountId, update: { [main.id]: { name } } }, method]);
  }
  if (updates.length) await run(updates);
}

export async function sync(stalwart: Stalwart, config: CalendarConfig, now = () => new Date()): Promise<SyncResult> {
  const result: SyncResult = { at: now().toISOString(), ok: false, created: [], updated: [], disabled: [], warnings: [], error: null };
  try {
    const domainIds = new Map((await stalwart.domains()).map((d) => [d.name.toLowerCase(), d.id]));
    for (const addr of [...config.teams, ...config.rooms].map((x) => x.address)) {
      const d = domainPart(addr);
      if (!domainIds.has(d)) domainIds.set(d, await stalwart.createDomain(d));
    }
    const domainNames = new Map([...domainIds].map(([name, id]) => [id, name]));
    const roleId = config.rooms.length ? await roomRole(stalwart) : null;
    const all = await stalwart.accounts();
    const byAddress = new Map(all.map((a) => [addressOf(a, domainNames), a]));

    const create: Record<string, Record<string, unknown>> = {};
    const update: Record<string, Record<string, unknown>> = {};
    const made: Array<{ key: string; kind: "room" | "team"; item: Room | Team }> = [];
    const kept: Array<{ id: string; kind: "room" | "team"; item: Room | Team }> = [];

    const claim = (item: Room | Team, kind: "room" | "team") => {
      const have = byAddress.get(item.address);
      const mark = kind === "room" ? ROOM_MARK : TEAM_MARK;
      if (have && have.externalId !== mark)
        throw new StalwartError(
          `${item.address} is already an account on the mail server that Calendar did not make as a ${kind}; give the ${kind} another address.`,
          200,
        );
      return have;
    };

    for (const room of config.rooms) {
      const have = claim(room, "room");
      const want = {
        description: room.name,
        roles: { "@type": "Custom", roleIds: { [roleId!]: true } },
        permissions: { "@type": "Inherit" },
      };
      if (!have) {
        const key = `r${made.length}`;
        create[key] = {
          "@type": "User",
          name: localPart(room.address),
          domainId: domainIds.get(domainPart(room.address)),
          externalId: ROOM_MARK,
          encryptionAtRest: { "@type": "Disabled" },
          ...want,
        };
        made.push({ key, kind: "room", item: room });
        result.created.push(room.address);
        continue;
      }
      const patch: Record<string, unknown> = {};
      if ((have.description ?? null) !== room.name) patch.description = room.name;
      if (have.roles?.["@type"] !== "Custom" || !sameSet(have.roles.roleIds, new Set([roleId!]))) patch.roles = want.roles;
      if (have.permissions?.["@type"] !== "Inherit") patch.permissions = want.permissions;
      if (Object.keys(patch).length) ((update[have.id] = patch), result.updated.push(room.address));
      kept.push({ id: have.id, kind: "room", item: room });
    }

    const teamIds = new Map<string, string>();
    for (const team of config.teams) {
      const have = claim(team, "team");
      if (!have) {
        const key = `t${made.length}`;
        create[key] = {
          "@type": "Group",
          name: localPart(team.address),
          domainId: domainIds.get(domainPart(team.address)),
          externalId: TEAM_MARK,
          description: team.name,
        };
        made.push({ key, kind: "team", item: team });
        result.created.push(team.address);
        continue;
      }
      if ((have.description ?? null) !== team.name) ((update[have.id] = { description: team.name }), result.updated.push(team.address));
      teamIds.set(team.address, have.id);
      kept.push({ id: have.id, kind: "team", item: team });
    }

    // Ours that the file no longer lists.
    const listed = new Set([...config.rooms, ...config.teams].map((x) => x.address));
    const gone = new Set<string>();
    for (const [addr, a] of byAddress) {
      if (!isOurs(a) || listed.has(addr)) continue;
      if (a.externalId === ROOM_MARK && !isDisabled(a)) {
        update[a.id] = { permissions: { "@type": "Merge", enabledPermissions: {}, disabledPermissions: ROOM_DISABLED } };
        result.disabled.push(addr);
      }
      if (a.externalId === TEAM_MARK) gone.add(a.id);
    }

    if (Object.keys(create).length || Object.keys(update).length) {
      const ids = await stalwart.setAccounts({ create, update });
      for (const m of made) {
        if (m.kind === "team") teamIds.set(m.item.address, ids[m.key]!);
        kept.push({ id: ids[m.key]!, kind: m.kind, item: m.item });
      }
    }

    // Team memberships: on each mailbox, the teams of the file it is a member of, next to any group an admin gave it.
    const ourTeams = new Set([...teamIds.values(), ...gone]);
    const memberships = new Map<string, Set<string>>();
    for (const team of config.teams)
      for (const m of team.members) {
        const a = byAddress.get(m);
        if (!a || a["@type"] !== "User" || isOurs(a)) {
          result.warnings.push(`${team.address}: ${m} is not a mailbox on the mail server yet.`);
          continue;
        }
        memberships.set(a.id, (memberships.get(a.id) ?? new Set()).add(teamIds.get(team.address)!));
      }
    const lost = new Map<string, number>();
    const membershipUpdate: Record<string, Record<string, unknown>> = {};
    for (const a of all) {
      if (a["@type"] !== "User" || isOurs(a)) continue;
      const current = Object.keys(a.memberGroupIds ?? {}).filter((g) => a.memberGroupIds![g]);
      const others = current.filter((g) => !ourTeams.has(g));
      const want = new Set([...others, ...(memberships.get(a.id) ?? [])]);
      if (sameSet(a.memberGroupIds, want)) continue;
      membershipUpdate[a.id] = { memberGroupIds: Object.fromEntries([...want].map((g) => [g, true])) };
      for (const g of current) if (gone.has(g)) lost.set(g, (lost.get(g) ?? 0) + 1);
      const addr = addressOf(a, domainNames);
      if (!result.updated.includes(addr)) result.updated.push(addr);
    }
    if (Object.keys(membershipUpdate).length) await stalwart.setAccounts({ update: membershipUpdate });
    for (const [addr, a] of byAddress) if (gone.has(a.id) && lost.has(a.id)) result.disabled.push(addr);

    for (const k of kept) await nameCollections(stalwart, k.kind, k.item.address, k.id, k.item.name);
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}
