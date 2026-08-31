import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { ModalDialog } from "../../components/ModalDialog";
import { IconAlert } from "../../components/icons";
import { getSystemStats } from "./system";
import type { SystemStats } from "./system";

export interface SystemStatsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const REFRESH_MS = 2000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function SystemStatsModal({ open, onClose }: SystemStatsModalProps) {
  const { t } = useT();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let inFlight = false;
    const fetchStats = (): void => {
      if (inFlight) return;
      inFlight = true;
      getSystemStats()
        .then((res) => {
          if (!cancelled) {
            setStats(res);
            setError("");
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : t("stats.error"));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    fetchStats();
    const timer = window.setInterval(fetchStats, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, t]);

  const rows: ReadonlyArray<readonly [string, string]> = stats
    ? [
        [t("stats.cpu"), `${stats.cpuPercent.toFixed(1)}%`],
        [t("stats.mem"), `${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memTotalBytes)} (${stats.memPercent.toFixed(1)}%)`],
        [t("stats.goroutines"), String(stats.numGoroutine)],
        [t("stats.heap"), formatBytes(stats.goHeapAllocBytes)],
        [t("stats.uptime"), formatUptime(stats.uptimeSeconds)],
        [t("stats.platform"), `${stats.os} / ${stats.arch}`],
        [t("stats.cores"), String(stats.numCpu)],
      ]
    : [];

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy="th-stats-title" closeLabel={t("common.close")}>
      <div className="th-stats">
        <h2 className="th-stats-title" id="th-stats-title">
          {t("stats.title")}
        </h2>
        {error.length > 0 ? (
          <span className="th-alert th-alert--error" role="alert">
            <IconAlert size={15} />
            <span>{error}</span>
          </span>
        ) : stats === null ? (
          <div className="th-stats-loading">{t("wizard.loading")}</div>
        ) : (
          <dl className="th-stats-grid">
            {rows.map(([label, value]) => (
              <div key={label} className="th-stats-row">
                <dt className="th-stats-label">{label}</dt>
                <dd className="th-stats-value">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </ModalDialog>
  );
}
