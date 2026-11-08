import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createCalendar } from "./calendar.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { identityDirectory } from "./identity.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { createStalwart } from "./stalwart.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const env = process.env;
const port = Number(env.PORT ?? 8080);
const dbPath = env.CALENDAR_DB ?? "/data/calendar.db";
const configPath = env.CALENDAR_CONFIG?.trim() || "/config/calendar.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = env.CALENDAR_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = env.CALENDAR_METRICS_PORT ? Number(env.CALENDAR_METRICS_PORT) : undefined;

// The address people open Calendar at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and
// subscription links use it.
const publicUrl = (env.CALENDAR_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
// The address calendar apps reach Stalwart's CalDAV and CardDAV at: the mail server's own name.
const davUrl = (env.CALENDAR_DAV_URL?.trim() || "https://mail.example.com").replace(/\/$/, "");
const stalwartUrl = env.CALENDAR_STALWART_URL?.trim() || "http://stalwart:8080";
const stalwartUser = env.CALENDAR_STALWART_USER?.trim() || "openasy-calendar";
const passwordFile = env.CALENDAR_STALWART_PASSWORD_FILE ?? "/run/secrets/calendar-stalwart-password";
const stalwartPassword = env.CALENDAR_STALWART_PASSWORD ?? (existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "");
if (!stalwartPassword) throw new Error(`The mail server's service account password is missing: mount it at ${passwordFile} or set CALENDAR_STALWART_PASSWORD.`);
const identityUrl = env.CALENDAR_IDENTITY_URL?.trim();
const identityTokenFile = env.CALENDAR_IDENTITY_TOKEN_FILE ?? "/run/secrets/identity-token";
const identityToken = env.CALENDAR_IDENTITY_TOKEN ?? (existsSync(identityTokenFile) ? readFileSync(identityTokenFile, "utf8").trim() : "");
if (identityUrl && !identityToken)
  log("warn", "CALENDAR_IDENTITY_URL is set without an API token; the directory comes from the mail server", { file: identityTokenFile });

const db = openDb(dbPath);
const secretsKeyFile = env.CALENDAR_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "calendar",
  productName: "OpenAsy Calendar",
  origin: publicUrl,
  // Locally the same Calendar is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: env.CALENDAR_PASSWORD_SIGN_IN !== "false",
  // Everyone with a mailbox signs in to plan their day; only some of them manage Calendar.
  users: true,
  oidc: oidcFromEnv(env, "CALENDAR_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const stalwart = createStalwart({ url: stalwartUrl, user: stalwartUser, password: stalwartPassword });
let file: ReturnType<typeof watchConfig> | undefined;
const calendar = createCalendar(db, stalwart, {
  davUrl,
  publicUrl,
  directory: identityUrl && identityToken ? identityDirectory({ url: identityUrl, token: identityToken }) : undefined,
  fileState: () => file?.state ?? null,
});
// The teams and rooms come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config) => void calendar.setConfig(config), {
  onChange: (state) =>
    state.error
      ? log("warn", "calendar file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "calendar file applied", { file: state.path, teams: state.teams, rooms: state.rooms }),
});
const products = parseProducts(env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    calendar,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(calendar, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "calendar started", { version, port, db: dbPath, config: configPath, dav: davUrl, stalwart: stalwartUrl, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "CALENDAR_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Calendar behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  // Changes made on the server by hand are put back, and a sync that failed is tried again.
  setInterval(() => void calendar.syncNow(), 5 * 60_000),
  // Rooms answer their invitations within half a minute.
  setInterval(() => void calendar.answerRooms(), 20_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
