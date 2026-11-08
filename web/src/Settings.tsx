import { Button, Callout, EmptyState, Panel, StatusBadge, useAgo } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Call, ConfigView, Summary, SyncResult } from "./api.ts";
import { FileSettingsPage, type FileSettingsGroup } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

const EXAMPLE = `teams:
  - address: sales-team@example.com
    name: Sales team
    members: [jane@example.com, ali@example.com]
rooms:
  - address: lisbon@rooms.example.com
    name: Lisbon
    seats: 6
    location: 3rd floor
    features: [Screen, Video bar]
  - address: projector@rooms.example.com
    name: Projector
    kind: equipment
    bookers: [jane@example.com]
    bookAhead: 30
`;

/** The teams and rooms as calendar.yaml sets them, and how the mail server was last brought in step. */
export function SettingsPage({ call }: { call: Call }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [config, setConfig] = useState<ConfigView>();
  const [summary, setSummary] = useState<Summary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    call<ConfigView>("/api/v1/config").then(setConfig, (e: Error) => setError(e.message));
    call<Summary>("/api/v1/summary").then(setSummary, () => {});
  }, [call]);
  useEffect(load, [load]);

  async function syncNow() {
    setBusy(true);
    try {
      await call<SyncResult>("/api/v1/sync", { method: "POST" });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!config) return error ? <EmptyState title={error} /> : <p className="text-sm text-fg-muted">{t("calendar.loading")}</p>;
  const file = config.file;
  const sync = summary?.sync ?? null;
  const groups: FileSettingsGroup[] = [
    {
      title: t("settings.teams"),
      description: t("settings.teamsDetail"),
      items: config.teams.length
        ? config.teams.map((team, i) => ({
            label: team.name,
            path: `teams[${i}]`,
            value: (
              <span className="flex flex-col">
                <span className="font-mono cal-wrap">{team.address}</span>
                <span className="text-fg-muted cal-wrap">{t("settings.members", { count: team.members.length, list: team.members.join(", ") })}</span>
              </span>
            ),
          }))
        : [{ label: t("settings.noTeams"), path: "teams", value: "–" }],
    },
    {
      title: t("settings.rooms"),
      description: t("settings.roomsDetail"),
      items: config.rooms.length
        ? config.rooms.map((r, i) => ({
            label: r.name,
            path: `rooms[${i}]`,
            value: (
              <span className="flex flex-col">
                <span className="font-mono cal-wrap">{r.address}</span>
                <span className="text-fg-muted">
                  {[
                    r.seats ? t("rooms.seats", { count: r.seats }) : t(`rooms.kind.${r.kind}`),
                    r.location,
                    t("rooms.acceptsDetail", { days: r.bookAhead }),
                    r.bookers.length ? t("settings.bookers", { list: r.bookers.join(", ") }) : t("rooms.everyone"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            ),
          }))
        : [{ label: t("settings.noRooms"), path: "rooms", value: "–" }],
    },
  ];
  return (
    <FileSettingsPage
      file="calendar.yaml"
      applied={file?.appliedAt ? ago(file.appliedAt) : t("settings.never")}
      groups={groups}
      yaml={file?.text?.trim() ? file.text : EXAMPLE}
      problems={
        <div className="cal-gap-below flex flex-col gap-2.5">
          {file?.error && (
            <Callout tone="warning" title={t("settings.fileError")}>
              <span className="cal-wrap">{file.error}</span>
            </Callout>
          )}
          {error && (
            <Callout tone="danger" title={t("settings.syncFailed")} onDismiss={() => setError(undefined)}>
              {error}
            </Callout>
          )}
          <Panel
            title={t("sync.title")}
            description={t("sync.description")}
            actions={
              can("admin") && (
                <Button size="sm" icon={<RefreshCw />} loading={busy} onClick={() => void syncNow()}>
                  {t("sync.now")}
                </Button>
              )
            }
          >
            {!sync ? (
              <p className="m-0 text-sm text-fg-muted">{t("sync.never")}</p>
            ) : (
              <div className="flex flex-col gap-1 text-sm">
                <span>
                  <StatusBadge tone={sync.ok ? "success" : "danger"}>{sync.ok ? t("sync.ok") : t("sync.failed")}</StatusBadge>{" "}
                  <span className="text-fg-muted">{ago(sync.at)}</span>
                </span>
                {sync.error && <span className="text-fg-muted cal-wrap">{sync.error}</span>}
                {sync.ok && (sync.created.length > 0 || sync.updated.length > 0 || sync.disabled.length > 0) && (
                  <span className="text-xs text-fg-muted">
                    {t("sync.changed", { created: sync.created.length, updated: sync.updated.length, disabled: sync.disabled.length })}
                  </span>
                )}
                {sync.warnings.map((w) => (
                  <span key={w} className="text-xs text-warning-text cal-wrap">
                    {w}
                  </span>
                ))}
              </div>
            )}
          </Panel>
        </div>
      }
    />
  );
}
