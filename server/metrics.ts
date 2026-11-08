// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  teams: number;
  rooms: number;
  /** Whether the last sync with the mail server worked, or null before the first. */
  syncOk: boolean | null;
  /** 1 when the calendar file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="calendar",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_calendar_teams Teams in the calendar file.",
    "# TYPE openasy_calendar_teams gauge",
    `openasy_calendar_teams ${g.teams}`,
    "# HELP openasy_calendar_rooms Rooms and equipment in the calendar file.",
    "# TYPE openasy_calendar_rooms gauge",
    `openasy_calendar_rooms ${g.rooms}`,
    "# HELP openasy_calendar_sync_ok 1 when the mail server was last brought in step with the file, 0 when that failed.",
    "# TYPE openasy_calendar_sync_ok gauge",
    ...(g.syncOk === null ? [] : [`openasy_calendar_sync_ok ${g.syncOk ? 1 : 0}`]),
    "# HELP openasy_calendar_config_error 1 when the calendar file could not be applied and its last good version is in use.",
    "# TYPE openasy_calendar_config_error gauge",
    `openasy_calendar_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
