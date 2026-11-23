import { invoke, isTauri } from '@tauri-apps/api/core';
import { loadNotes } from '../notes/api';
import { computePlaybookEdge, formatRMultiple, loadPlaybookState } from '../playbook/store';
import { getLocalDateIso, loadRoutinesState } from '../routines/store';
import { loadWorkspaceJson, saveWorkspaceJson } from '../workspace/storage';

export interface WorkspaceStats {
  notesCount: number;
  screenshotsCount: number;
  playbookCount: number;
  aiChatsCount: number;
  alertsCount: number;
  watchlistCount: number;
  routinesCount: number;
  tasksCount: number;
  totalFiles: number;
  totalBytes: number;
}

export interface SyncResult {
  backupDir: string;
  syncedAt: string;
  copiedFiles: number;
  skippedFiles: number;
  totalFiles: number;
  totalBytes: number;
}

export interface RestoreResult {
  restoredFiles: number;
  totalBytes: number;
  restoredAt: string;
}

export interface ZipExportResult {
  path: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export interface CloudPrefs {
  syncFolder: string;
  autoSyncEnabled: boolean;
  lastSyncedAt: string | null;
  lastBackupAt: string | null;
}

export type ReviewRangeId = 'this_week' | 'last_week' | 'last_30d';

const STORAGE_KEY = 'cloud';
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const AUTO_SYNC_STARTUP_DELAY_MS = 8_000;

export function defaultCloudPrefs(): CloudPrefs {
  return {
    syncFolder: '',
    autoSyncEnabled: false,
    lastSyncedAt: null,
    lastBackupAt: null
  };
}

export async function loadCloudPrefs(): Promise<CloudPrefs> {
  const def = defaultCloudPrefs();
  const loaded = await loadWorkspaceJson<Partial<CloudPrefs>>(STORAGE_KEY, def);
  return {
    syncFolder: typeof loaded?.syncFolder === 'string' ? loaded.syncFolder : '',
    autoSyncEnabled: Boolean(loaded?.autoSyncEnabled),
    lastSyncedAt: typeof loaded?.lastSyncedAt === 'string' ? loaded.lastSyncedAt : null,
    lastBackupAt: typeof loaded?.lastBackupAt === 'string' ? loaded.lastBackupAt : null
  };
}

export async function saveCloudPrefs(prefs: CloudPrefs): Promise<void> {
  await saveWorkspaceJson(STORAGE_KEY, prefs);
}

export async function getWorkspaceStats(): Promise<WorkspaceStats> {
  if (!isTauri()) {
    return {
      notesCount: 0,
      screenshotsCount: 0,
      playbookCount: 0,
      aiChatsCount: 0,
      alertsCount: 0,
      watchlistCount: 0,
      routinesCount: 0,
      tasksCount: 0,
      totalFiles: 0,
      totalBytes: 0
    };
  }
  return invoke<WorkspaceStats>('cloud_workspace_stats');
}

export async function pickSyncFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>('cloud_pick_folder');
}

export async function syncToFolder(targetDir: string): Promise<SyncResult> {
  return invoke<SyncResult>('cloud_sync_to_folder', { targetDir });
}

export async function restoreFromFolder(sourceDir: string): Promise<RestoreResult> {
  return invoke<RestoreResult>('cloud_restore_from_folder', { sourceDir });
}

export async function exportBackupZip(): Promise<ZipExportResult | null> {
  if (!isTauri()) return null;
  return invoke<ZipExportResult | null>('cloud_export_zip');
}

export async function importBackupZip(): Promise<RestoreResult | null> {
  if (!isTauri()) return null;
  return invoke<RestoreResult | null>('cloud_import_zip');
}

export async function saveTextExport(
  defaultFilename: string,
  content: string,
  ext: 'md' | 'html'
): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>('cloud_save_text_export', {
      defaultFilename,
      content,
      ext
    });
  }
  // Browser fallback download
  const blob = new Blob([content], {
    type: ext === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultFilename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return defaultFilename;
}

async function readImageBase64(filename: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('cloud_read_image_base64', { filename });
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Quiet background folder auto-sync on app startup & periodically when enabled by user. */
export function startCloudAutoSync(): () => void {
  if (!isTauri()) return () => {};

  let stopped = false;
  let running = false;

  const runOnce = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const prefs = await loadCloudPrefs();
      if (prefs.autoSyncEnabled && prefs.syncFolder.trim()) {
        const res = await syncToFolder(prefs.syncFolder.trim());
        await saveCloudPrefs({ ...prefs, lastSyncedAt: res.syncedAt });
      }
    } catch {
      // Non-fatal background sync failure (e.g. disconnected external drive)
    }
    running = false;
  };

  const startupTimer = setTimeout(() => {
    void runOnce();
  }, AUTO_SYNC_STARTUP_DELAY_MS);

  const periodicTimer = setInterval(() => {
    void runOnce();
  }, AUTO_SYNC_INTERVAL_MS);

  return () => {
    stopped = true;
    clearTimeout(startupTimer);
    clearInterval(periodicTimer);
  };
}

function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function computeReviewWindow(range: ReviewRangeId): {
  startIso: string;
  endIso: string;
  label: string;
} {
  const today = getLocalDateIso();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = dt.getUTCDay(); // 0=Sun..6=Sat
  const diffFromMon = wd === 0 ? 6 : wd - 1;
  const thisMon = addDaysIso(today, -diffFromMon);

  if (range === 'this_week') {
    return { startIso: thisMon, endIso: today, label: `This Week (${thisMon} to ${today})` };
  }
  if (range === 'last_week') {
    const lastMon = addDaysIso(thisMon, -7);
    const lastSun = addDaysIso(thisMon, -1);
    return { startIso: lastMon, endIso: lastSun, label: `Last Week (${lastMon} to ${lastSun})` };
  }
  const start30 = addDaysIso(today, -29);
  return { startIso: start30, endIso: today, label: `Last 30 Days (${start30} to ${today})` };
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function exportWeeklyReview(
  range: ReviewRangeId,
  format: 'md' | 'html'
): Promise<{ path: string | null; entriesCount: number; notesCount: number }> {
  const win = computeReviewWindow(range);
  const [playbook, allNotes, routines] = await Promise.all([
    loadPlaybookState(),
    loadNotes(),
    loadRoutinesState()
  ]);

  const entries = playbook.entries
    .filter((e) => e.date >= win.startIso && e.date <= win.endIso)
    .sort((a, b) => b.date.localeCompare(a.date));

  const notes = allNotes
    .filter((n) => !n.deletedAt && n.date >= win.startIso && n.date <= win.endIso)
    .sort((a, b) => b.date.localeCompare(a.date));

  const edge = computePlaybookEdge(entries);

  const routineDays = Object.entries(routines.history)
    .filter(([date]) => date >= win.startIso && date <= win.endIso)
    .sort(([a], [b]) => a.localeCompare(b));
  const fullRoutineDays = routineDays.filter(([, r]) => r.total > 0 && r.done >= r.total).length;
  const activeRoutineDays = routineDays.filter(([, r]) => r.done > 0).length;

  const fileStem = `DeplyzeWorkflow-Review-${win.startIso}-to-${win.endIso}`;

  if (format === 'md') {
    const lines: string[] = [];
    lines.push(`# DeplyzeWorkflow Trading Review`);
    lines.push(`**Period:** ${win.label}`);
    lines.push('');
    lines.push(`## Playbook Edge Summary`);
    lines.push(`- **Setups Logged:** ${edge.totalLogged}`);
    lines.push(`- **Win Rate:** ${edge.winRatePct !== null ? `${edge.winRatePct}%` : '—'}`);
    lines.push(`- **Total R:** ${edge.totalR !== null ? formatRMultiple(edge.totalR) : '—'}`);
    lines.push(`- **Best Setup:** ${edge.bestSetup ?? '—'}`);
    lines.push('');
    lines.push(`## Routines Consistency`);
    lines.push(`- **Completed Days:** ${fullRoutineDays} full / ${activeRoutineDays} active days logged`);
    for (const [date, rec] of routineDays) {
      if (rec.done > 0) {
        lines.push(`  - ${date}: ${rec.done}/${rec.total} rituals`);
      }
    }
    lines.push('');
    lines.push(`## Playbook Setups (${entries.length})`);
    if (entries.length === 0) {
      lines.push(`_No playbook setups tagged during this period._`);
    } else {
      for (const e of entries) {
        const rStr = formatRMultiple(e.rMultiple);
        lines.push(
          `### ${e.date} · ${e.symbol} · ${e.title || 'Setup'} (${e.grade} | ${e.outcome}${rStr ? ` ${rStr}` : ''})`
        );
        if (e.setupType) lines.push(`- **Setup Type:** ${e.setupType}`);
        if (e.notes.trim()) {
          lines.push('');
          lines.push(e.notes.trim());
        }
        lines.push('');
      }
    }
    lines.push(`## Trading Notes (${notes.length})`);
    if (notes.length === 0) {
      lines.push(`_No notes logged during this period._`);
    } else {
      for (const n of notes) {
        lines.push(`### ${n.date} · ${n.symbol} · ${n.title.trim() || 'Untitled'}`);
        if (n.body.trim()) {
          lines.push('');
          lines.push(n.body.trim());
        }
        lines.push('');
      }
    }

    const saved = await saveTextExport(`${fileStem}.md`, lines.join('\n'), 'md');
    return { path: saved, entriesCount: entries.length, notesCount: notes.length };
  }

  // Standalone Printable HTML with base64-embedded screenshots
  const imageCache = new Map<string, string>();
  const neededFilenames = new Set<string>();
  for (const e of entries) {
    for (const a of e.attachments) neededFilenames.add(a.filename);
  }
  for (const n of notes) {
    for (const a of n.attachments) neededFilenames.add(a.filename);
  }

  for (const fname of neededFilenames) {
    const dataUri = await readImageBase64(fname);
    if (dataUri) imageCache.set(fname, dataUri);
  }

  const renderShotsHtml = (filenames: string[]) => {
    const imgs: string[] = [];
    for (const fn of filenames) {
      const uri = imageCache.get(fn);
      if (uri) {
        imgs.push(`<img class="shot" src="${uri}" alt="Chart screenshot" />`);
      }
    }
    return imgs.length > 0 ? `<div class="shots">${imgs.join('')}</div>` : '';
  };

  const entriesHtml =
    entries.length === 0
      ? `<p class="muted">No playbook setups tagged during this period.</p>`
      : entries
          .map((e) => {
            const rStr = formatRMultiple(e.rMultiple);
            const shots = renderShotsHtml(e.attachments.map((a) => a.filename));
            return `
              <article class="card">
                <div class="card-head">
                  <div>
                    <span class="sym">${escapeHtml(e.symbol)}</span>
                    <span class="badge">${escapeHtml(e.grade)}</span>
                    ${e.setupType ? `<span class="tag">${escapeHtml(e.setupType)}</span>` : ''}
                  </div>
                  <div class="meta">${escapeHtml(e.outcome)}${rStr ? ` ${escapeHtml(rStr)}` : ''} · ${escapeHtml(e.date)}</div>
                </div>
                <h3>${escapeHtml(e.title.trim() || `${e.symbol} Setup`)}</h3>
                ${e.notes.trim() ? `<p class="body">${escapeHtml(e.notes.trim())}</p>` : ''}
                ${shots}
              </article>
            `;
          })
          .join('\n');

  const notesHtml =
    notes.length === 0
      ? `<p class="muted">No notes logged during this period.</p>`
      : notes
          .map((n) => {
            const shots = renderShotsHtml(n.attachments.map((a) => a.filename));
            return `
              <article class="card">
                <div class="card-head">
                  <span class="sym">${escapeHtml(n.symbol)}</span>
                  <span class="meta">${escapeHtml(n.date)}</span>
                </div>
                <h3>${escapeHtml(n.title.trim() || 'Untitled Note')}</h3>
                ${n.body.trim() ? `<p class="body">${escapeHtml(n.body.trim())}</p>` : ''}
                ${shots}
              </article>
            `;
          })
          .join('\n');

  const routineRowsHtml =
    routineDays.filter(([, r]) => r.done > 0).length === 0
      ? `<p class="muted">No ritual logs recorded for this period.</p>`
      : `<div class="routine-grid">${routineDays
          .filter(([, r]) => r.done > 0)
          .map(
            ([date, r]) =>
              `<div class="r-chip"><strong>${escapeHtml(date)}</strong><span>${r.done}/${r.total}</span></div>`
          )
          .join('')}</div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DeplyzeWorkflow Review — ${escapeHtml(win.label)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #131722; background: #f8f9fb; margin: 0; padding: 32px 20px; line-height: 1.5; }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e0e3eb; }
  h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.02em; }
  .period { color: #6a6d78; font-size: 13px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0 26px; }
  .stat { background: #fff; border: 1px solid #e0e3eb; border-radius: 10px; padding: 12px 14px; }
  .stat-k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6a6d78; }
  .stat-v { font-size: 18px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #6a6d78; margin: 26px 0 12px; }
  .card { background: #fff; border: 1px solid #e0e3eb; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; page-break-inside: avoid; }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
  .sym { font-weight: 700; font-size: 13px; }
  .badge, .tag { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 5px; font-size: 11px; font-weight: 600; background: #eef1f7; color: #131722; }
  .meta { font-size: 12px; color: #6a6d78; font-variant-numeric: tabular-nums; }
  .card h3 { margin: 0 0 6px; font-size: 15px; }
  .body { margin: 0; font-size: 13.5px; white-space: pre-wrap; color: #2b303d; }
  .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-top: 12px; }
  .shot { width: 100%; border-radius: 8px; border: 1px solid #e0e3eb; display: block; }
  .routine-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .r-chip { background: #fff; border: 1px solid #e0e3eb; border-radius: 8px; padding: 6px 10px; font-size: 12px; display: flex; gap: 8px; }
  .muted { color: #6a6d78; font-size: 13px; }
  @media print { body { background: #fff; padding: 0; } .card, .stat { box-shadow: none; } }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>DeplyzeWorkflow Trading Review</h1>
      <div class="period">${escapeHtml(win.label)}</div>
    </header>
    <section class="stats">
      <div class="stat"><div class="stat-k">Setups Logged</div><div class="stat-v">${edge.totalLogged}</div></div>
      <div class="stat"><div class="stat-k">Win Rate</div><div class="stat-v">${edge.winRatePct !== null ? `${edge.winRatePct}%` : '—'}</div></div>
      <div class="stat"><div class="stat-k">Total R</div><div class="stat-v">${edge.totalR !== null ? escapeHtml(formatRMultiple(edge.totalR)) : '—'}</div></div>
      <div class="stat"><div class="stat-k">Routines Full Days</div><div class="stat-v">${fullRoutineDays}</div></div>
    </section>
    <h2>Playbook Setups (${entries.length})</h2>
    ${entriesHtml}
    <h2>Trading Notes (${notes.length})</h2>
    ${notesHtml}
    <h2>Routines Consistency</h2>
    ${routineRowsHtml}
  </div>
</body>
</html>`;

  const saved = await saveTextExport(`${fileStem}.html`, html, 'html');
  return { path: saved, entriesCount: entries.length, notesCount: notes.length };
}
