<script lang="ts">
  import PanelShell from './PanelShell.svelte';
  import {
    deleteImageFile,
    getImageUrl,
    getImagesDir,
    loadNotes,
    saveNotes
  } from '../notes/api';
  import { formatShortDate, formatTime, type Note } from '../notes/types';

  interface Props {
    theme: 'dark' | 'light';
    onClose: () => void;
  }

  let { theme, onClose }: Props = $props();

  let notes = $state<Note[]>([]);
  let imagesDir = $state('');
  let loaded = $state(false);
  let confirmingEmpty = $state(false);

  const trashedNotes = $derived(
    notes
      .filter((n) => Boolean(n.deletedAt))
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
  );

  async function persist() {
    try {
      await saveNotes($state.snapshot(notes));
    } catch {
      // Ignore transient write errors
    }
  }

  async function restoreNote(noteId: string) {
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;
    delete target.deletedAt;
    target.updatedAt = new Date().toISOString();
    confirmingEmpty = false;
    await persist();
  }

  async function purgeNote(noteId: string) {
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;
    const filenames = target.attachments.map((a) => a.filename);
    notes = notes.filter((n) => n.id !== noteId);
    confirmingEmpty = false;
    await persist();

    for (const filename of filenames) {
      try {
        await deleteImageFile(filename);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async function emptyTrash() {
    if (!confirmingEmpty) {
      confirmingEmpty = true;
      return;
    }

    const toPurge = notes.filter((n) => Boolean(n.deletedAt));
    const filenames: string[] = [];
    for (const n of toPurge) {
      for (const a of n.attachments) {
        filenames.push(a.filename);
      }
    }
    notes = notes.filter((n) => !n.deletedAt);
    confirmingEmpty = false;
    await persist();

    for (const filename of filenames) {
      try {
        await deleteImageFile(filename);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  $effect(() => {
    let cancelled = false;
    void Promise.all([loadNotes(), getImagesDir()])
      .then(([loadedNotes, dir]) => {
        if (cancelled) return;
        notes = loadedNotes;
        imagesDir = dir;
        loaded = true;
      })
      .catch(() => {
        if (!cancelled) loaded = true;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<PanelShell {theme} title="Trash" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <ellipse cx="10" cy="5.25" rx="4.75" ry="1.75" />
      <path d="M5.25 5.25l.9 9.4a2.35 2.35 0 0 0 2.35 2.1h3a2.35 2.35 0 0 0 2.35-2.1l.9-9.4" />
      <path d="m8.6 10.35 2.8 2.8m0-2.8-2.8 2.8" />
    </svg>
  {/snippet}

  <div class="trash-panel" class:light={theme === 'light'}>
    {#if loaded && trashedNotes.length > 0}
      <div class="toolbar">
        <span class="trash-count">
          {trashedNotes.length} deleted {trashedNotes.length === 1 ? 'note' : 'notes'}
        </span>

        <div class="toolbar-actions">
          {#if confirmingEmpty}
            <button
              class="cancel-empty"
              type="button"
              onclick={() => (confirmingEmpty = false)}
            >
              Cancel
            </button>
          {/if}
          <button
            class="empty-button"
            class:confirming={confirmingEmpty}
            type="button"
            onclick={() => void emptyTrash()}
          >
            {confirmingEmpty ? 'Confirm empty' : 'Empty Trash'}
          </button>
        </div>
      </div>
    {/if}

    <div class="trash-list">
      {#if !loaded}
        <div class="empty-state">Loading trash…</div>
      {:else if trashedNotes.length === 0}
        <div class="empty-state">
          <p>Trash is empty</p>
          <span class="empty-hint">Deleted notes appear here until restored or permanently removed</span>
        </div>
      {:else}
        {#each trashedNotes as note (note.id)}
          <div class="trash-row">
            <div class="row-top">
              <span class="row-title" class:untitled={!note.title.trim()}>
                {note.title.trim() || 'Untitled'}
              </span>

              <div class="row-actions">
                <button
                  class="action-pill"
                  type="button"
                  title="Restore note"
                  onclick={() => void restoreNote(note.id)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M5.25 7.25A5.75 5.75 0 1 1 4.4 11.5" />
                    <path d="M5.25 3.75v3.5h3.5" />
                  </svg>
                  <span>Restore</span>
                </button>

                <button
                  class="action-icon danger"
                  type="button"
                  aria-label="Delete permanently"
                  title="Delete permanently"
                  onclick={() => void purgeNote(note.id)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m5.5 5.5 9 9m0-9-9 9" />
                  </svg>
                </button>
              </div>
            </div>

            {#if note.body.trim()}
              <div class="row-excerpt">{note.body.trim()}</div>
            {/if}

            <div class="row-footer">
              <div class="row-meta">
                <span class="symbol-pill">{note.symbol}</span>
                <span class="meta-date">
                  {formatShortDate(note.date)}
                  {#if note.deletedAt}
                    · Deleted {formatTime(note.deletedAt)}
                  {/if}
                </span>
              </div>

              {#if note.attachments.length > 0}
                <div class="row-thumbs">
                  {#each note.attachments.slice(0, 3) as att (att.id)}
                    <img
                      class="row-thumb"
                      src={getImageUrl(att.filename, imagesDir)}
                      alt=""
                      aria-hidden="true"
                    />
                  {/each}
                  {#if note.attachments.length > 3}
                    <span class="thumb-more">+{note.attachments.length - 3}</span>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</PanelShell>

<style>
  .trash-panel {
    --tp-bg: #000000;
    --tp-border: #2a2e39;
    --tp-row-divider: #2a2e39;
    --tp-text: #d1d4dc;
    --tp-secondary: #787b86;
    --tp-pill-bg: #1e222d;
    --tp-hover: rgba(255, 255, 255, 0.04);
    --tp-control-hover: rgba(255, 255, 255, 0.07);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--tp-text);
    background: var(--tp-bg);
    transition: color 150ms ease, background-color 150ms ease;
  }

  .trash-panel.light {
    --tp-bg: #ffffff;
    --tp-border: #e0e3eb;
    --tp-row-divider: #f0f2f5;
    --tp-text: #131722;
    --tp-secondary: #6a6d78;
    --tp-pill-bg: #f2f2f2;
    --tp-hover: rgba(0, 0, 0, 0.03);
    --tp-control-hover: rgba(0, 0, 0, 0.05);
  }

  .toolbar {
    height: 40px;
    flex: 0 0 40px;
    padding: 0 16px;
    border-bottom: 1px solid var(--tp-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    user-select: none;
  }

  .trash-count {
    font-size: 12.5px;
    color: var(--tp-secondary);
    font-variant-numeric: tabular-nums;
  }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cancel-empty {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--tp-border);
    border-radius: 6px;
    color: var(--tp-text);
    background: transparent;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .cancel-empty:hover {
    background: var(--tp-control-hover);
  }

  .empty-button {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--tp-border);
    border-radius: 6px;
    color: var(--tp-text);
    background: transparent;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .empty-button:hover {
    color: #f23645;
    border-color: rgba(242, 54, 69, 0.45);
    background: rgba(242, 54, 69, 0.08);
  }

  .empty-button.confirming {
    color: #ffffff;
    border-color: #f23645;
    background: #f23645;
  }

  .trash-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .trash-list::-webkit-scrollbar {
    display: none;
  }

  .empty-state {
    padding: 64px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--tp-secondary);
    font-size: 13px;
  }

  .empty-state p {
    margin: 0;
  }

  .empty-hint {
    font-size: 12px;
    opacity: 0.8;
    max-width: 260px;
    line-height: 1.45;
  }

  .trash-row {
    padding: 12px 16px;
    border-bottom: 1px solid var(--tp-row-divider);
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: background-color 150ms ease;
  }

  .trash-row:hover {
    background: var(--tp-hover);
  }

  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .row-title {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--tp-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-title.untitled {
    color: var(--tp-secondary);
    font-weight: 500;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }

  .action-pill {
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--tp-border);
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--tp-text);
    background: transparent;
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .action-pill:hover {
    background: var(--tp-control-hover);
  }

  .action-pill svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .action-icon {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--tp-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .action-icon.danger:hover {
    color: #f23645;
    background: rgba(242, 54, 69, 0.1);
  }

  .action-icon svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .row-excerpt {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--tp-secondary);
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
  }

  .row-footer {
    margin-top: 2px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .symbol-pill {
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    color: var(--tp-text);
    background: var(--tp-pill-bg);
  }

  .meta-date {
    font-size: 11.5px;
    color: var(--tp-secondary);
    font-variant-numeric: tabular-nums;
  }

  .row-thumbs {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .row-thumb {
    width: 28px;
    height: 22px;
    border-radius: 4px;
    object-fit: cover;
    border: 1px solid var(--tp-border);
    display: block;
  }

  .thumb-more {
    font-size: 11px;
    color: var(--tp-secondary);
    font-variant-numeric: tabular-nums;
    padding-left: 2px;
  }

  button:focus-visible {
    outline: 1px solid var(--tp-text);
    outline-offset: -2px;
  }
</style>
