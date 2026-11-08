// The company directory from OpenAsy Identity, when it is set up (CALENDAR_IDENTITY_URL and an API token with the
// viewer role): people's names and groups, read from its /api/v1/people at most every five minutes. Without it, the
// directory is everyone with a mailbox on the mail server, by the names Mail's domains file gives them.

export interface DirectoryPerson {
  email: string;
  name: string;
  groups: string[];
}

export interface Directory {
  people(): Promise<DirectoryPerson[]>;
}

export function identityDirectory({
  url,
  token,
  fetch: f = fetch,
  clock = Date.now,
}: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  clock?: () => number;
}): Directory {
  const base = url.replace(/\/$/, "");
  let cache: { people: DirectoryPerson[]; until: number } | null = null;
  return {
    async people() {
      if (cache && cache.until > clock()) return cache.people;
      const res = await f(`${base}/api/v1/people`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Identity answered ${res.status}`);
      const body = (await res.json()) as { people?: Array<{ email?: string; name?: string; status?: string; groups?: string[] }> };
      const people = (body.people ?? [])
        .filter((p) => p.email && p.status !== "disabled")
        .map((p) => ({ email: p.email!.toLowerCase(), name: p.name || p.email!, groups: Array.isArray(p.groups) ? p.groups.map(String) : [] }));
      cache = { people, until: clock() + 5 * 60_000 };
      return people;
    },
  };
}
