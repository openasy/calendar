// Starts the app on a random port for tests, against a mail server in memory with Mail's mailboxes on it.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createCalendar } from "./calendar.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { fakeStalwart, SERVICE_PASSWORD, SERVICE_USER } from "./fake-stalwart.ts";
import { createStalwart } from "./stalwart.ts";

export const ADMIN_TOKEN = "test-admin-token";
/** Tokens that act as a signed-in person, as personTokens. */
export const JANE = "test-jane-token";
export const ALI = "test-ali-token";
export const GONE = "test-gone-token";
export const STRANGER = "test-stranger-token";

/** The calendar file the tests start with. */
export const FILE = `
teams:
  - { address: sales-team@example.com, name: Sales team, members: [jane@example.com, ali@example.com] }
rooms:
  - { address: lisbon@rooms.example.com, name: Lisbon, seats: 6, features: [Screen] }
`;

export async function startApp(opts: Partial<AppOptions> & { version: string; file?: string }) {
  const db = openDb(":memory:");
  const { file = FILE, ...rest } = opts;
  const fake = fakeStalwart();
  fake.mailbox("jane@example.com", "Jane Doe");
  fake.mailbox("ali@example.com", "Ali Yılmaz");
  const gone = fake.mailbox("gone@example.com", "Gone Person");
  gone.permissions = { "@type": "Merge", disabledPermissions: { authenticate: true } };
  const stalwart = createStalwart({ url: "http://stalwart:8080", user: SERVICE_USER, password: SERVICE_PASSWORD, fetch: fake.fetch });
  const calendar = createCalendar(db, stalwart, { davUrl: "https://mail.example.com", publicUrl: "https://calendar.example.com" });
  await calendar.setConfig(parseConfig(file));
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "calendar", productName: "OpenAsy Calendar", origin: base, users: true });
  const personTokens = { [JANE]: "jane@example.com", [ALI]: "ali@example.com", [GONE]: "gone@example.com", [STRANGER]: "stranger@example.net" };
  handler = createApp({ db, calendar, auth, adminToken: ADMIN_TOKEN, personTokens, ...rest });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, calendar, fake, auth, base, admin: as(ADMIN_TOKEN), jane: as(JANE), ali: as(ALI), as, close };
}
