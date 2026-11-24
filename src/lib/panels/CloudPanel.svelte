<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import {
    defaultCloudPrefs,
    exportBackupZip,
    exportWeeklyReview,
    formatBytes,
    getWorkspaceStats,
    importBackupZip,
    loadCloudPrefs,
    pickSyncFolder,
    restoreFromFolder,
    saveCloudPrefs,
    syncToFolder,
    type CloudPrefs,
    type ReviewRangeId,
    type WorkspaceStats
  } from '../cloud/api';

  interface Props {
    theme: 'dark' | 'light';
    onClose: () => void;
  }

  let { theme, onClose }: Props = $props();

  const REVIEW_RANGES: { id: ReviewRangeId; label: string }[] = [
    { id: 'this_week', label: 'This Week' },
    { id: 'last_week', label: 'Last Week' },
    { id: 'last_30d', label: 'Last 30 Days' }
  ];

  let cloudPrefs = $state<CloudPrefs>(defaultCloudPrefs());
  let stats = $state<WorkspaceStats>({
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
  });
  let reviewRange = $state<ReviewRangeId>('this_week');
  let busyAction = $state<string | null>(null);
  let statusNotice = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
  let pendingConfirm = $state<'restore_folder' | 'restore_zip' | null>(null);

  const workspaceItemsTotal = $derived(
    stats.watchlistCount + stats.tasksCount + stats.alertsCount + stats.routinesCount
  );

  async function refreshStats() {
    try {
      stats = await getWorkspaceStats();
    } catch {
      // ignore
    }
  }

  onMount(() => {
    void loadCloudPrefs().then((loaded) => {
      cloudPrefs = loaded;
    });
    void refreshStats();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pendingConfirm) {
        pendingConfirm = null;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  function showNotice(kind: 'ok' | 'err', text: string) {
    statusNotice = { kind, text };
  }

  async function updatePrefs(next: CloudPrefs) {
    cloudPrefs = next;
    await saveCloudPrefs(next);
  }

  async function handleChooseFolder() {
    if (busyAction) return;
    busyAction = 'pick';
    try {
      const picked = await pickSyncFolder();
      if (picked) {
        await updatePrefs({ ...cloudPrefs, syncFolder: picked });
        showNotice('ok', 'Sync folder connected.');
      }
    } catch (err) {
      showNotice('err', String(err));
    }
    busyAction = null;
  }

  async function handleToggleAutoSync() {
    const nextEnabled = !cloudPrefs.autoSyncEnabled;
    await updatePrefs({ ...cloudPrefs, autoSyncEnabled: nextEnabled });
  }

  async function handleSyncNow() {
    if (busyAction || !cloudPrefs.syncFolder.trim()) return;
    busyAction = 'sync';
    statusNotice = null;
    try {
      const res = await syncToFolder(cloudPrefs.syncFolder.trim());
      await updatePrefs({ ...cloudPrefs, lastSyncedAt: res.syncedAt });
      showNotice(
        'ok',
        res.copiedFiles > 0
          ? `Synced ${res.copiedFiles} updated file${res.copiedFiles === 1 ? '' : 's'} (${res.totalFiles} total).`
          : `Already up to date (${res.totalFiles} files verified).`
      );
      await refreshStats();
    } catch (err) {
      showNotice('err', String(err));
    }
    busyAction = null;
  }

  async function handleExportZip() {
    if (busyAction) return;
    busyAction = 'export_zip';
    statusNotice = null;
    try {
      const res = await exportBackupZip();
      if (res) {
        await updatePrefs({ ...cloudPrefs, lastBackupAt: res.createdAt });
        showNotice('ok', `Exported ${res.fileCount} files (${formatBytes(res.totalBytes)}).`);
      }
    } catch (err) {
      showNotice('err', String(err));
    }
    busyAction = null;
  }

  async function executeConfirmedRestore() {
    const mode = pendingConfirm;
    pendingConfirm = null;
    if (!mode || busyAction) return;

    busyAction = mode;
    statusNotice = null;
    try {
      const res =
        mode === 'restore_folder'
          ? await restoreFromFolder(cloudPrefs.syncFolder.trim())
          : await importBackupZip();

      if (res) {
        showNotice(
          'ok',
          `Restored ${res.restoredFiles} files (${formatBytes(res.totalBytes)}). Reloading workspace…`
        );
        setTimeout(() => {
          window.location.reload();
        }, 700);
      }
    } catch (err) {
      showNotice('err', String(err));
    }
    busyAction = null;
  }

  async function handleExportReview(format: 'md' | 'html') {
    if (busyAction) return;
    busyAction = `review_${format}`;
    statusNotice = null;
    try {
      const res = await exportWeeklyReview(reviewRange, format);
      if (res.path) {
        showNotice(
          'ok',
          `Saved ${format.toUpperCase()} review (${res.entriesCount} setups, ${res.notesCount} notes).`
        );
      }
    } catch (err) {
      showNotice('err', String(err));
    }
    busyAction = null;
  }

  function formatStamp(iso: string | null): string {
    if (!iso) return 'Never';
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }
</script>

<PanelShell {theme} title="Backup & Sync" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 15.25h7.75a3 3 0 0 0 .5-5.95 4.25 4.25 0 0 0-8.15-.65 3.35 3.35 0 0 0-.1 6.6Z" />
    </svg>
  {/snippet}

  <div class="cloud-panel" class:light={theme === 'light'}>
    <div class="cl-scroll">
      {#if statusNotice}
        <div class="notice-bar" class:err={statusNotice.kind === 'err'} role="status">
          <span>{statusNotice.text}</span>
          <button
            class="notice-x"
            type="button"
            aria-label="Dismiss"
            onclick={() => (statusNotice = null)}
          >
            ×
          </button>
        </div>
      {/if}

      <!-- 1. Local Data Summary -->
      <section class="cl-card">
        <div class="card-head">
          <span class="section-label">Local Data</span>
          <div class="head-right">
            <span class="size-pill">{formatBytes(stats.totalBytes)}</span>
            <button
              class="mini-icon"
              type="button"
              title="Refresh storage summary"
              aria-label="Refresh storage summary"
              onclick={() => void refreshStats()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.35-3.4M13 3.25v2.75h-2.75" />
              </svg>
            </button>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-box">
            <span class="stat-val">{stats.notesCount} / {stats.screenshotsCount}</span>
            <span class="stat-lbl">Notes & shots</span>
          </div>
          <div class="stat-box">
            <span class="stat-val">{stats.playbookCount}</span>
            <span class="stat-lbl">Playbook</span>
          </div>
          <div class="stat-box">
            <span class="stat-val">{stats.aiChatsCount}</span>
            <span class="stat-lbl">AI chats</span>
          </div>
          <div class="stat-box">
            <span class="stat-val">{workspaceItemsTotal}</span>
            <span class="stat-lbl">Lists / Alerts / Tasks</span>
          </div>
        </div>
      </section>

      <!-- 2. Auto-Sync Folder -->
      <section class="cl-card">
        <div class="card-head">
          <span class="section-label">Auto-Sync Folder</span>
          <span class="meta-stamp">Last: {formatStamp(cloudPrefs.lastSyncedAt)}</span>
        </div>

        <p class="card-desc">
          Mirror your workspace into a local OneDrive, Google Drive, or Dropbox folder — zero accounts required.
        </p>

        <div class="folder-row">
          <div
            class="folder-path"
            class:empty={!cloudPrefs.syncFolder}
            title={cloudPrefs.syncFolder || 'No sync folder selected'}
          >
            {cloudPrefs.syncFolder || 'No folder chosen'}
          </div>
          <button
            class="btn-outline"
            type="button"
            disabled={busyAction !== null}
            onclick={() => void handleChooseFolder()}
          >
            Choose
          </button>
        </div>

        <button
          class="toggle-row"
          type="button"
          role="checkbox"
          aria-checked={cloudPrefs.autoSyncEnabled}
          disabled={!cloudPrefs.syncFolder}
          onclick={() => void handleToggleAutoSync()}
        >
          <span class="cb-box" class:checked={cloudPrefs.autoSyncEnabled}>
            {#if cloudPrefs.autoSyncEnabled}
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 6.2 5 8.7 9.5 3.5" />
              </svg>
            {/if}
          </span>
          <span class="toggle-text">Auto-sync on startup & every 10 min</span>
        </button>

        <div class="btn-row">
          <button
            class="btn-primary"
            type="button"
            disabled={!cloudPrefs.syncFolder || busyAction !== null}
            onclick={() => void handleSyncNow()}
          >
            {busyAction === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            class="btn-outline"
            type="button"
            disabled={!cloudPrefs.syncFolder || busyAction !== null}
            onclick={() => (pendingConfirm = 'restore_folder')}
          >
            Restore from folder
          </button>
        </div>
      </section>

      <!-- 3. Full Backup & Restore (.zip) -->
      <section class="cl-card">
        <div class="card-head">
          <span class="section-label">Full Backup (.zip)</span>
          <span class="meta-stamp">Last: {formatStamp(cloudPrefs.lastBackupAt)}</span>
        </div>

        <p class="card-desc">
          Save a complete portable archive of Notes, screenshots, Playbook, AI chats, Lists, Alerts, Tasks, and Routines.
        </p>

        <div class="btn-row">
          <button
            class="btn-primary"
            type="button"
            disabled={busyAction !== null}
            onclick={() => void handleExportZip()}
          >
            {busyAction === 'export_zip' ? 'Exporting…' : 'Export Backup (.zip)'}
          </button>
          <button
            class="btn-outline"
            type="button"
            disabled={busyAction !== null}
            onclick={() => (pendingConfirm = 'restore_zip')}
          >
            Restore (.zip)
          </button>
        </div>
      </section>

      <!-- 4. Weekly Review Export -->
      <section class="cl-card">
        <div class="card-head">
          <span class="section-label">Weekly Review Export</span>
        </div>

        <p class="card-desc">
          Bundle your period's Playbook edge, tagged setups with embedded screenshots, Notes, and Routines into a review digest.
        </p>

        <div class="range-pills" role="tablist" aria-label="Weekly review date range">
          {#each REVIEW_RANGES as opt (opt.id)}
            <button
              class="range-pill"
              class:active={reviewRange === opt.id}
              type="button"
              onclick={() => (reviewRange = opt.id)}
            >
              {opt.label}
            </button>
          {/each}
        </div>

        <div class="btn-row">
          <button
            class="btn-outline"
            type="button"
            disabled={busyAction !== null}
            onclick={() => void handleExportReview('md')}
          >
            {busyAction === 'review_md' ? 'Saving…' : 'Markdown (.md)'}
          </button>
          <button
            class="btn-primary"
            type="button"
            disabled={busyAction !== null}
            onclick={() => void handleExportReview('html')}
          >
            {busyAction === 'review_html' ? 'Building…' : 'Printable Report (.html)'}
          </button>
        </div>
      </section>
    </div>
  </div>
</PanelShell>

{#if pendingConfirm}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="confirm-backdrop"
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) pendingConfirm = null;
    }}
  >
    <div class="confirm-modal" class:light={theme === 'light'} role="alertdialog" aria-modal="true">
      <div class="confirm-head">
        <h3>
          {pendingConfirm === 'restore_folder'
            ? 'Restore from sync folder?'
            : 'Restore backup archive?'}
        </h3>
        <button class="close-x" type="button" onclick={() => (pendingConfirm = null)}>×</button>
      </div>
      <p class="confirm-copy">
        {pendingConfirm === 'restore_folder'
          ? 'This will replace your local Notes, Playbook, AI chats, and workspace settings with the mirrored backup in your sync folder and reload the app.'
          : 'Choose a DeplyzeWorkflow .zip backup file to replace your local Notes, Playbook, AI chats, and workspace settings. The app will reload once complete.'}
      </p>
      <div class="confirm-foot">
        <button class="modal-cancel" type="button" onclick={() => (pendingConfirm = null)}>
          Cancel
        </button>
        <button class="modal-confirm" type="button" onclick={() => void executeConfirmedRestore()}>
          {pendingConfirm === 'restore_folder' ? 'Restore' : 'Choose .zip'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cloud-panel {
    --cl-bg: var(--dark-bg-panel);
    --cl-surface: var(--dark-bg-surface);
    --cl-surface-alt: var(--dark-bg-surface-alt);
    --cl-border: var(--dark-border);
    --cl-border-soft: var(--dark-border-subtle);
    --cl-text: var(--dark-text-primary);
    --cl-secondary: var(--dark-text-secondary);
    --cl-hover: var(--dark-hover);
    --cl-cta-bg: var(--dark-cta-bg);
    --cl-cta-fg: var(--dark-cta-fg);
    --cl-check-border: var(--dark-border-check);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--cl-text);
    background: var(--cl-bg);
  }

  .cloud-panel.light {
    --cl-bg: #ffffff;
    --cl-surface: #f7f8fa;
    --cl-surface-alt: #eff1f5;
    --cl-border: #dfe3eb;
    --cl-border-soft: #eef0f4;
    --cl-text: #131722;
    --cl-secondary: #6a6d78;
    --cl-hover: rgba(0, 0, 0, 0.035);
    --cl-cta-bg: #131722;
    --cl-cta-fg: #ffffff;
    --cl-check-border: #9da2b0;
  }

  .cl-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 14px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .cl-scroll::-webkit-scrollbar {
    display: none;
  }

  .notice-bar {
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(8, 153, 129, 0.14);
    border: 1px solid rgba(8, 153, 129, 0.3);
    color: var(--cl-text);
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .notice-bar.err {
    background: rgba(242, 54, 69, 0.13);
    border-color: rgba(242, 54, 69, 0.3);
    color: #f23645;
  }

  .notice-x {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 0 3px;
    opacity: 0.75;
  }

  .cl-card {
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--cl-border-soft);
    background: var(--cl-surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--cl-secondary);
  }

  .head-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .size-pill {
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--cl-surface-alt);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .meta-stamp {
    font-size: 11px;
    color: var(--cl-secondary);
    font-variant-numeric: tabular-nums;
  }

  .mini-icon {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--cl-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .mini-icon:hover {
    color: var(--cl-text);
    background: var(--cl-hover);
  }

  .mini-icon svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 7px;
  }

  .stat-box {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--cl-surface-alt);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat-val {
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .stat-lbl {
    font-size: 11px;
    color: var(--cl-secondary);
  }

  .card-desc {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--cl-secondary);
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .folder-path {
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--cl-border);
    background: var(--cl-bg);
    font-size: 11.5px;
    line-height: 28px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder-path.empty {
    color: var(--cl-secondary);
  }

  .toggle-row {
    border: 0;
    padding: 2px 0;
    background: transparent;
    color: var(--cl-text);
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .toggle-row:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .cb-box {
    width: 15px;
    height: 15px;
    flex: 0 0 15px;
    border-radius: 4px;
    border: 1.5px solid var(--cl-check-border);
    display: grid;
    place-items: center;
  }

  .cb-box.checked {
    border-color: var(--cl-cta-bg);
    background: var(--cl-cta-bg);
    color: var(--cl-cta-fg);
  }

  .cb-box svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .toggle-text {
    font-size: 12px;
  }

  .range-pills {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 3px;
    border-radius: 8px;
    background: var(--cl-surface-alt);
  }

  .range-pill {
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--cl-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .range-pill.active {
    background: var(--cl-bg);
    color: var(--cl-text);
  }

  .btn-row {
    display: flex;
    gap: 7px;
  }

  .btn-primary,
  .btn-outline {
    flex: 1;
    height: 31px;
    padding: 0 10px;
    border-radius: 7px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 120ms ease, background-color 120ms ease;
  }

  .folder-row .btn-outline {
    flex: 0 0 auto;
    height: 30px;
  }

  .btn-primary {
    border: 0;
    background: var(--cl-cta-bg);
    color: var(--cl-cta-fg);
  }

  .btn-primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-outline {
    border: 1px solid var(--cl-border);
    background: transparent;
    color: var(--cl-text);
  }

  .btn-outline:hover:not(:disabled) {
    background: var(--cl-hover);
  }

  .btn-primary:disabled,
  .btn-outline:disabled {
    opacity: 0.42;
    cursor: default;
  }

  /* Confirmation modal matching SettingsModal dark glass */
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 130;
    background: rgba(0, 0, 0, 0.38);
    display: grid;
    place-items: center;
  }

  .confirm-modal {
    width: 390px;
    max-width: calc(100vw - 32px);
    padding: 20px;
    border-radius: 12px;
    color: var(--dark-text-strong);
    background: var(--dark-bg-glass);
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
    box-shadow: var(--dark-shadow-modal);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .confirm-modal.light {
    color: #131722;
    background: #ffffff;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.18);
  }

  .confirm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .confirm-head h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .close-x {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
  }

  .confirm-copy {
    margin: 0;
    font-size: 13px;
    line-height: 1.48;
    opacity: 0.86;
  }

  .confirm-foot {
    margin-top: 4px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .modal-cancel,
  .modal-confirm {
    height: 33px;
    padding: 0 15px;
    border-radius: 8px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .modal-cancel {
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: transparent;
    color: inherit;
  }

  .confirm-modal.light .modal-cancel {
    border-color: #d8dce6;
  }

  .modal-confirm {
    border: 0;
    background: var(--dark-cta-bg);
    color: var(--dark-cta-fg);
  }

  .confirm-modal.light .modal-confirm {
    background: #131722;
    color: #ffffff;
  }
</style>
