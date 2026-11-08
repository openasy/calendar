import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, GONE, JANE, STRANGER, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "calendar-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const sent = res.headers.get("content-type")!.split(";")[0]!;
  const type = response.content?.[sent] ? sent : "*/*";
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${sent}, which openapi.json does not list`).toBeDefined();
  if (type === "*/*") return { res, body: await res.arrayBuffer() };

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const admin = (init: RequestInit = {}) => ({ ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" } });
const as = (token: string, init: RequestInit = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
});
const jmap = (calls: unknown[]) => JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"], methodCalls: calls });

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Calendar's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
  });

  it("the file and syncs", async () => {
    await call("GET", "/api/v1/config", admin());
    await call("GET", "/api/v1/config", as(JANE));
    await call("POST", "/api/v1/sync", admin());
    await call("POST", "/api/v1/sync", as(JANE));
    await call("GET", "/api/v1/sync", admin());
  });

  it("calendars", async () => {
    const { body: s } = await call("GET", "/api/v1/session", as(JANE));
    const accountId = (s as { accountId: string }).accountId;
    await call("GET", "/api/v1/session", as(STRANGER));
    await call("GET", "/api/v1/session", as(GONE));
    await call("GET", "/api/v1/session", admin());
    await call("POST", "/api/v1/jmap", as(JANE, { body: jmap([["Calendar/get", { accountId }, "0"]]) }));
    await call("POST", "/api/v1/jmap", as(JANE, { body: jmap([["x:Account/get", {}, "0"]]) }));
    await call("POST", "/api/v1/jmap", as(JANE, { body: "{" }));
    await call("POST", "/api/v1/jmap", as(JANE, { body: "x".repeat(1024 * 1024 + 1) }));
    await call("POST", "/api/v1/upload", as(JANE, { body: "BEGIN:VCALENDAR", headers: { "content-type": "text/calendar" } }));
    await call("GET", "/api/v1/directory", as(JANE));
    await call(
      "POST",
      "/api/v1/availability",
      as(JANE, { body: JSON.stringify({ people: ["ali@example.com"], from: "2026-11-09T00:00:00Z", to: "2026-11-10T00:00:00Z" }) }),
    );
    await call("POST", "/api/v1/availability", as(JANE, { body: JSON.stringify({ people: [] }) }));
    await call("GET", "/api/v1/rooms", as(JANE), "/api/v1/rooms?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z");
    await call("GET", "/api/v1/rooms", as(JANE), "/api/v1/rooms?from=x");
    app.fake.state.ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    await call("GET", "/api/v1/export/calendars/{account}/{id}", as(JANE), `/api/v1/export/calendars/${accountId}/b`);
    await call("GET", "/api/v1/export/calendars/{account}/{id}", as(JANE), `/api/v1/export/calendars/${accountId}/nope`);
    await call("GET", "/api/v1/export/addressbooks/{account}/{id}", as(JANE), `/api/v1/export/addressbooks/${accountId}/b`);
    await call("GET", "/api/v1/export/addressbooks/{account}/{id}", as(JANE), `/api/v1/export/addressbooks/${accountId}/nope`);
    const { body: link } = await call("POST", "/api/v1/subscriptions", as(JANE, { body: JSON.stringify({ accountId, calendarId: "b", busy: false }) }));
    await call("POST", "/api/v1/subscriptions", as(JANE, { body: JSON.stringify({}) }));
    await call("GET", "/api/v1/subscriptions", as(JANE));
    const token = /\/ics\/(.+)\.ics$/.exec((link as { url: string }).url)![1]!;
    await call("GET", "/ics/{token}.ics", {}, `/ics/${token}.ics`);
    await call("DELETE", "/api/v1/subscriptions/{id}", as(JANE), `/api/v1/subscriptions/${(link as { id: string }).id}`);
    await call("DELETE", "/api/v1/subscriptions/{id}", as(JANE), "/api/v1/subscriptions/nope");
    await call("GET", "/ics/{token}.ics", {}, `/ics/${token}.ics`);
    app.fake.state.down = true;
    try {
      await call("POST", "/api/v1/upload", as(STRANGER, { body: "x" }));
      await call("GET", "/api/v1/directory", as(JANE));
    } finally {
      app.fake.state.down = false;
    }
  });

  it("leavers", async () => {
    await call("GET", "/api/v1/leavers", admin());
    await call("GET", "/api/v1/leavers", as(JANE));
    await call(
      "POST",
      "/api/v1/leavers/{address}/handover",
      admin({ body: JSON.stringify({ to: "jane@example.com", ids: [] }) }),
      "/api/v1/leavers/gone@example.com/handover",
    );
    await call("POST", "/api/v1/leavers/{address}/handover", admin({ body: JSON.stringify({}) }), "/api/v1/leavers/gone@example.com/handover");
    await call(
      "POST",
      "/api/v1/leavers/{address}/handover",
      admin({ body: JSON.stringify({ to: "jane@example.com", ids: ["x"] }) }),
      "/api/v1/leavers/jane@example.com/handover",
    );
    await call("POST", "/api/v1/leavers/{address}/cancel", admin({ body: JSON.stringify({ ids: [] }) }), "/api/v1/leavers/gone@example.com/cancel");
    await call("POST", "/api/v1/leavers/{address}/cancel", admin({ body: "{" }), "/api/v1/leavers/gone@example.com/cancel");
  });

  it("devices", async () => {
    const { body } = await call("POST", "/api/v1/devices", as(JANE, { body: JSON.stringify({ name: "Phone" }) }));
    await call("POST", "/api/v1/devices", as(JANE, { body: JSON.stringify({ name: "" }) }));
    await call("POST", "/api/v1/devices", as(JANE, { body: "{" }));
    await call("GET", "/api/v1/devices", as(JANE));
    await call("GET", "/api/v1/devices", {});
    await call("DELETE", "/api/v1/devices/{id}", as(JANE), `/api/v1/devices/${(body as { id: string }).id}`);
    await call("DELETE", "/api/v1/devices/{id}", as(JANE), "/api/v1/devices/nope");
    app.fake.state.down = true;
    try {
      await call("GET", "/api/v1/devices", as(JANE));
    } finally {
      app.fake.state.down = false;
    }
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
