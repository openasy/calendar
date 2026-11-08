import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { fakeStalwart, SERVICE_PASSWORD, SERVICE_USER } from "./fake-stalwart.ts";
import { createStalwart } from "./stalwart.ts";
import { ROOM_MARK, ROOM_PERMISSIONS, ROOM_ROLE, sync, TEAM_MARK } from "./sync.ts";

function setup() {
  const fake = fakeStalwart();
  const jane = fake.mailbox("jane@example.com", "Jane Doe");
  const ali = fake.mailbox("ali@example.com", "Ali Yılmaz");
  const stalwart = createStalwart({ url: "http://stalwart:8080", user: SERVICE_USER, password: SERVICE_PASSWORD, fetch: fake.fetch });
  return { fake, jane, ali, stalwart };
}

const FILE = `
teams:
  - { address: sales-team@example.com, name: Sales team, members: [jane@example.com, ali@example.com, new@example.com] }
rooms:
  - { address: lisbon@rooms.example.com, name: Lisbon }
`;

describe("sync", () => {
  it("makes rooms with their own role in their own domain, and teams whose members are the mailboxes", async () => {
    const { fake, jane, ali, stalwart } = setup();
    const r = await sync(stalwart, parseConfig(FILE));
    expect(r).toMatchObject({ ok: true, error: null });
    expect(r.created.sort()).toEqual(["lisbon@rooms.example.com", "sales-team@example.com"]);
    expect(r.warnings).toEqual(["sales-team@example.com: new@example.com is not a mailbox on the mail server yet."]);
    expect([...fake.domains.values()].map((d) => d.name)).toContain("rooms.example.com");
    const role = [...fake.roles.values()].find((x) => x.description === ROOM_ROLE)!;
    expect(Object.keys(role.enabledPermissions!).sort()).toEqual([...ROOM_PERMISSIONS].sort());
    // A room never sends mail of its own.
    expect(role.enabledPermissions!.emailSend).toBeUndefined();
    const room = fake.accountByAddress("lisbon@rooms.example.com")!;
    expect(room).toMatchObject({ "@type": "User", externalId: ROOM_MARK, description: "Lisbon", roles: { "@type": "Custom", roleIds: { [role.id]: true } } });
    const team = fake.accountByAddress("sales-team@example.com")!;
    expect(team).toMatchObject({ "@type": "Group", externalId: TEAM_MARK, description: "Sales team" });
    expect(jane.memberGroupIds).toEqual({ [team.id]: true });
    expect(ali.memberGroupIds).toEqual({ [team.id]: true });
    // The team's calendar carries its name, as calendar apps show it.
    expect(fake.calendars.get(team.id)![0]!.name).toBe("Sales team");
    expect(fake.calendars.get(room.id)![0]!.name).toBe("Lisbon");
  });

  it("changes nothing the second time, and puts back a change made on the server", async () => {
    const { fake, stalwart } = setup();
    await sync(stalwart, parseConfig(FILE));
    const again = await sync(stalwart, parseConfig(FILE));
    expect([again.created, again.updated, again.disabled]).toEqual([[], [], []]);
    fake.accountByAddress("lisbon@rooms.example.com")!.description = "Renamed by hand";
    expect((await sync(stalwart, parseConfig(FILE))).updated).toEqual(["lisbon@rooms.example.com"]);
  });

  it("keeps the groups an admin gave a mailbox", async () => {
    const { fake, jane, stalwart } = setup();
    jane.memberGroupIds = { "admins-group": true };
    await sync(stalwart, parseConfig(FILE));
    const team = fake.accountByAddress("sales-team@example.com")!;
    expect(jane.memberGroupIds).toEqual({ "admins-group": true, [team.id]: true });
  });

  it("refuses an address the server has for something Calendar did not make", async () => {
    const { stalwart } = setup();
    const r = await sync(stalwart, parseConfig("rooms:\n  - { address: jane@example.com, name: Jane's room }"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("jane@example.com is already an account on the mail server that Calendar did not make as a room; give the room another address.");
  });

  it("takes a room out of service and a team's members away when they leave the file, and deletes neither", async () => {
    const { fake, jane, stalwart } = setup();
    await sync(stalwart, parseConfig(FILE));
    const r = await sync(stalwart, parseConfig(""));
    expect(r.disabled.sort()).toEqual(["lisbon@rooms.example.com", "sales-team@example.com"]);
    expect(fake.accountByAddress("lisbon@rooms.example.com")!.permissions).toMatchObject({
      "@type": "Merge",
      disabledPermissions: { authenticate: true, emailReceive: true },
    });
    expect(fake.accountByAddress("sales-team@example.com")).toBeDefined();
    expect(jane.memberGroupIds).toEqual({});
    // Back in the file, the room takes invitations again.
    await sync(stalwart, parseConfig(FILE));
    expect(fake.accountByAddress("lisbon@rooms.example.com")!.permissions).toEqual({ "@type": "Inherit" });
  });

  it("says when the mail server cannot be reached", async () => {
    const { fake, stalwart } = setup();
    fake.state.down = true;
    const r = await sync(stalwart, parseConfig(FILE));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot be reached/);
  });
});
