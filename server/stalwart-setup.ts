// Calendar's first start on the mail server Mail set up: the service account Calendar uses, made through Stalwart's
// API. Stalwart's own first start (its host name and first domain) is Mail's (mail/server/stalwart-setup.ts); this
// step refuses to run before it. Safe to run again: it only sets the account's role and password.
//
//   docker compose exec -e STALWART_RECOVERY_ADMIN=admin:<password> calendar node server/stalwart-setup.ts
//
// STALWART_RECOVERY_ADMIN is the same admin:<password> Stalwart is started with.
import { existsSync, readFileSync } from "node:fs";
import { CORE, MANAGEMENT } from "./stalwart.ts";

export interface StalwartSetup {
  /** Where Calendar reaches Stalwart's HTTP listener. */
  url: string;
  /** user:password of Stalwart's recovery admin (STALWART_RECOVERY_ADMIN). */
  recovery: string;
  /** The account Calendar manages and impersonates with, and its password. */
  user: string;
  password: string;
  /** The domain the account is made in; the server's first domain when not given. */
  domain?: string;
}

async function jmap(url: string, credentials: string, methodCalls: unknown[]): Promise<Array<[string, Record<string, any>, string]>> {
  const res = await fetch(`${url.replace(/\/$/, "")}/jmap/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(credentials).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ using: [CORE, MANAGEMENT], methodCalls }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error("Stalwart refused STALWART_RECOVERY_ADMIN: give the same admin:<password> it was started with.");
  if (!res.ok) throw new Error(`Stalwart answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { methodResponses: Array<[string, Record<string, any>, string]> }).methodResponses;
}

function check(r: [string, Record<string, any>, string] | undefined) {
  if (!r) throw new Error("Stalwart sent no answer.");
  if (r[0] === "error") throw new Error(`Stalwart: ${r[1].description ?? r[1].type}`);
  const failed = ["notCreated", "notUpdated"].flatMap((k) => Object.values((r[1][k] as Record<string, { description?: string }> | null) ?? {}));
  if (failed.length) throw new Error(`Stalwart: ${failed.map((e) => e.description ?? "refused").join("; ")}`);
  return r[1];
}

/** Makes or updates Calendar's service account; returns whether it was made now. */
export async function setUpStalwart(o: StalwartSetup): Promise<"created" | "updated"> {
  const [probe] = await jmap(o.url, o.recovery, [["x:Domain/get", { properties: ["name"] }, "0"]]);
  if (probe?.[0] === "error" && /bootstrap/i.test(String(probe[1].description)))
    throw new Error("Stalwart has not had its first start yet: do Mail's (node server/stalwart-setup.ts in the mail container), then run this again.");
  const domains = check(probe).list as Array<{ id: string; name: string }>;
  const want = o.domain?.toLowerCase();
  const domain = want ? domains.find((d) => d.name === want) : domains[0];
  if (!domain) throw new Error(o.domain ? `${o.domain} is not a domain of the mail server.` : "The mail server has no domain yet.");
  const accounts = check((await jmap(o.url, o.recovery, [["x:Account/get", { properties: ["name", "domainId"] }, "0"]]))[0]).list as Array<{
    id: string;
    name: string;
    domainId: string;
  }>;
  const name = o.user.split("@")[0]!;
  const existing = accounts.find((a) => a.name === name && a.domainId === domain.id);
  // The administrator role holds the impersonate permission, which Calendar needs to act as each person and room.
  const account = { roles: { "@type": "Admin" }, credentials: { "0": { "@type": "Password", secret: o.password } }, description: "OpenAsy Calendar" };
  check(
    (
      await jmap(o.url, o.recovery, [
        [
          "x:Account/set",
          existing
            ? { update: { [existing.id]: account } }
            : { create: { s: { "@type": "User", name, domainId: domain.id, encryptionAtRest: { "@type": "Disabled" }, ...account } } },
          "0",
        ],
      ])
    )[0],
  );
  return existing ? "updated" : "created";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const passwordFile = env.CALENDAR_STALWART_PASSWORD_FILE ?? "/run/secrets/calendar-stalwart-password";
  const password = env.CALENDAR_STALWART_PASSWORD ?? (existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : "");
  const recovery = env.STALWART_RECOVERY_ADMIN ?? "";
  if (!recovery.includes(":")) throw new Error("Set STALWART_RECOVERY_ADMIN to the admin:<password> Stalwart is started with.");
  if (!password) throw new Error(`The service account's password is missing: mount it at ${passwordFile} or set CALENDAR_STALWART_PASSWORD.`);
  const user = env.CALENDAR_STALWART_USER?.trim() || "openasy-calendar";
  const done = await setUpStalwart({
    url: env.CALENDAR_STALWART_URL?.trim() || "http://stalwart:8080",
    recovery,
    user,
    password,
    domain: env.CALENDAR_STALWART_DOMAIN?.trim() || undefined,
  });
  console.log(`Stalwart is ready: Calendar's service account ${user} is ${done} with the administrator role.`);
}
