<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import ImageLightbox from './ImageLightbox.svelte';
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    NOTE_UNDO_WINDOW_MS,
    deleteImageFile,
    getImageUrl,
    getImagesDir,
    getRecentDeletedNotes,
    isSupportedImagePath,
    loadNotes,
    permanentlyDeleteNote,
    purgeExpiredDeletedNotes,
    saveImageFromBlob,
    saveImageFromPath,
    saveNotes,
    subscribeNotesChanged
  } from '../notes/api';
  import {
    formatDateHeading,
    formatShortDate,
    formatTime,
    isNoteEmpty,
    makeNoteId,
    todayNairobiIso,
    type Note,
    type NoteAttachment
  } from '../notes/types';
  import { saveNoteToPlaybook, subscribePlaybook } from '../playbook/store';

  type NotesTab = 'all' | 'symbol' | 'pinned';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    onClose: () => void;
  }

  let { theme, activeSymbol, activeFullSymbol, onClose }: Props = $props();

  let notes = $state<Note[]>([]);
  let imagesDir = $state('');
  let loaded = $state(false);
  let activeTab = $state<NotesTab>('all');
  let searchQuery = $state('');
  let activeNoteId = $state<string | null>(null);
  let saving = $state(false);
  let dragActive = $state(false);
  let editingSymbol = $state(false);
  let symbolDraft = $state('');

  let lightboxState = $state<{ index: number } | null>(null);
  let undoToast = $state<{ noteId: string; title: string; deletedAtMs: number } | null>(null);
  let restoredBanner = $state<string | null>(null);
  let clockTickMs = $state(Date.now());
  let playbookNoteIds = $state<Record<string, boolean>>({});
  let playbookSavedId = $state<string | null>(null);

  let panelEl: HTMLDivElement | undefined = $state();
  let titleInputEl: HTMLInputElement | undefined = $state();
  let bodyEl: HTMLTextAreaElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();
  let symbolInputEl: HTMLInputElement | undefined = $state();

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let restoredTimer: ReturnType<typeof setTimeout> | undefined;
  let dragDepth = 0;

  const activeNotes = $derived(notes.filter((n) => !n.deletedAt));
  const recentDeletedNotes = $derived(getRecentDeletedNotes(notes, clockTickMs));
  const activeUndoTarget = $derived.by(() => {
    if (undoToast) {
      const stillValid = recentDeletedNotes.find((n) => n.id === undoToast?.noteId);
      if (stillValid && stillValid.deletedAt) {
        return {
          noteId: stillValid.id,
          title: stillValid.title.trim() || stillValid.symbol || 'Note',
          deletedAtMs: Date.parse(stillValid.deletedAt)
        };
      }
    }
    const latest = recentDeletedNotes[0];
    if (latest && latest.deletedAt) {
      return {
        noteId: latest.id,
        title: latest.title.trim() || latest.symbol || 'Note',
        deletedAtMs: Date.parse(latest.deletedAt)
      };
    }
    return null;
  });

  function formatCountdown(deletedAtMs: number, nowMs: number): string {
    const remainingSec = Math.max(0, Math.ceil((deletedAtMs + NOTE_UNDO_WINDOW_MS - nowMs) / 1000));
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  const symbolCount = $derived(
    activeNotes.filter((n) => n.symbol.toUpperCase() === activeSymbol.toUpperCase()).length
  );

  const activeNote = $derived(
    activeNoteId ? (activeNotes.find((n) => n.id === activeNoteId) ?? null) : null
  );

  const filteredNotes = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeNotes
      .filter((n) => {
        if (activeTab === 'symbol' && n.symbol.toUpperCase() !== activeSymbol.toUpperCase()) {
          return false;
        }
        if (activeTab === 'pinned' && !n.pinned) {
          return false;
        }
        if (!q) return true;
        return (
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q) ||
          n.symbol.toLowerCase().includes(q) ||
          n.date.includes(q)
        );
      })
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  });

  const groupedNotes = $derived.by(() => {
    const map = new Map<string, Note[]>();
    for (const n of filteredNotes) {
      const list = map.get(n.date) ?? [];
      list.push(n);
      map.set(n.date, list);
    }
    return Array.from(map.entries()).map(([date, items]) => ({
      date,
      heading: formatDateHeading(date),
      items
    }));
  });

  async function persistNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    saving = true;
    try {
      await saveNotes($state.snapshot(notes));
    } catch {
      // Ignore transient write errors
    } finally {
      saving = false;
    }
  }

  function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saving = true;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persistNow();
    }, 400);
  }

  function discardIfEmpty(noteId: string) {
    const idx = notes.findIndex((n) => n.id === noteId);
    if (idx === -1) return;
    if (isNoteEmpty(notes[idx])) {
      notes.splice(idx, 1);
      persistNow();
    } else if (saveTimer) {
      persistNow();
    }
  }

  function createNewNote(focusTitle = true): Note {
    const now = new Date().toISOString();
    const note: Note = {
      id: makeNoteId(),
      title: '',
      body: '',
      date: todayNairobiIso(),
      symbol: activeSymbol || 'XAUUSD',
      fullSymbol: activeFullSymbol || 'OANDA:XAUUSD',
      pinned: activeTab === 'pinned',
      attachments: [],
      createdAt: now,
      updatedAt: now
    };
    notes.unshift(note);
    activeNoteId = note.id;
    editingSymbol = false;

    if (focusTitle) {
      queueMicrotask(() => {
        titleInputEl?.focus();
      });
    }
    return note;
  }

  function openNote(noteId: string) {
    activeNoteId = noteId;
    editingSymbol = false;
    queueMicrotask(resizeTextarea);
  }

  function backToList() {
    if (activeNoteId) {
      discardIfEmpty(activeNoteId);
    }
    editingSymbol = false;
    activeNoteId = null;
  }

  function handlePanelClose() {
    if (activeNoteId) {
      discardIfEmpty(activeNoteId);
    } else if (saveTimer) {
      persistNow();
    }
    onClose();
  }

  function touchNote(note: Note) {
    note.updatedAt = new Date().toISOString();
    schedulePersist();
  }

  function togglePin(noteId: string) {
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;
    target.pinned = !target.pinned;
    target.updatedAt = new Date().toISOString();
    persistNow();
  }

  async function handleSaveNoteToPlaybook(note: Note) {
    try {
      await saveNoteToPlaybook($state.snapshot(note));
      playbookSavedId = note.id;
      setTimeout(() => {
        if (playbookSavedId === note.id) playbookSavedId = null;
      }, 1800);
    } catch {
      // ignore
    }
  }

  function softDeleteNote(noteId: string, permanent = false) {
    const target = notes.find((n) => n.id === noteId);
    if (!target) return;

    if (permanent || isNoteEmpty(target)) {
      if (activeNoteId === noteId) activeNoteId = null;
      if (undoToast?.noteId === noteId) undoToast = null;
      void permanentlyDeleteNote($state.snapshot(notes), noteId).then((remaining) => {
        notes = remaining;
      });
      return;
    }

    const nowMs = Date.now();
    target.deletedAt = new Date(nowMs).toISOString();
    if (activeNoteId === noteId) {
      activeNoteId = null;
    }
    clockTickMs = nowMs;
    persistNow();

    undoToast = {
      noteId: target.id,
      title: target.title.trim() || target.symbol || 'Note',
      deletedAtMs: nowMs
    };
  }

  function undoDelete(specificNoteId?: string) {
    const targetId = specificNoteId ?? activeUndoTarget?.noteId;
    if (!targetId) return;
    const target = notes.find((n) => n.id === targetId && Boolean(n.deletedAt));
    if (!target) {
      undoToast = null;
      return;
    }
    const deletedMs = Date.parse(target.deletedAt ?? '');
    if (!Number.isFinite(deletedMs) || Date.now() - deletedMs >= NOTE_UNDO_WINDOW_MS) {
      void purgeExpiredDeletedNotes($state.snapshot(notes)).then((res) => {
        notes = res.notes;
      });
      undoToast = null;
      return;
    }

    const restoredTitle = target.title.trim() || target.symbol || 'Note';
    delete target.deletedAt;
    target.updatedAt = new Date().toISOString();
    persistNow();

    if (undoToast?.noteId === targetId) {
      undoToast = null;
    }
    if (restoredTimer) clearTimeout(restoredTimer);
    restoredBanner = `Restored “${restoredTitle}”`;
    restoredTimer = setTimeout(() => {
      restoredBanner = null;
      restoredTimer = undefined;
    }, 2400);
  }

  function deletePermanentlyNow(noteId: string) {
    if (undoToast?.noteId === noteId) {
      undoToast = null;
    }
    void permanentlyDeleteNote($state.snapshot(notes), noteId).then((remaining) => {
      notes = remaining;
    });
  }

  function handleWindowKeyDown(e: KeyboardEvent) {
    if (lightboxState) return;
    const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
    if (!isUndo) return;

    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }

    if (activeUndoTarget) {
      e.preventDefault();
      e.stopPropagation();
      undoDelete(activeUndoTarget.noteId);
    }
  }

  function cleanNoteExcerpt(raw: string): string {
    return raw
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function startSymbolEdit() {
    if (!activeNote) return;
    symbolDraft = activeNote.symbol;
    editingSymbol = true;
    queueMicrotask(() => {
      symbolInputEl?.focus();
      symbolInputEl?.select();
    });
  }

  function commitSymbolEdit() {
    if (!activeNote || !editingSymbol) return;
    const next = symbolDraft.trim().toUpperCase();
    if (next && next !== activeNote.symbol) {
      activeNote.symbol = next;
      activeNote.fullSymbol = next;
      touchNote(activeNote);
    }
    editingSymbol = false;
  }

  async function attachBlobs(blobs: { blob: Blob; name?: string }[]) {
    if (blobs.length === 0) return;
    let target = activeNote;
    if (!target) {
      target = createNewNote(false);
    }
    for (const item of blobs) {
      try {
        const attachment = await saveImageFromBlob(item.blob, target.id, target.date, item.name);
        target.attachments.push(attachment);
        target.updatedAt = new Date().toISOString();
      } catch {
        // Ignore unsupported image payload
      }
    }
    persistNow();
  }

  async function attachFilePaths(paths: string[]) {
    const valid = paths.filter(isSupportedImagePath);
    if (valid.length === 0) return;
    let target = activeNote;
    if (!target) {
      target = createNewNote(false);
    }
    for (const p of valid) {
      try {
        const attachment = await saveImageFromPath(p, target.id, target.date);
        target.attachments.push(attachment);
        target.updatedAt = new Date().toISOString();
      } catch {
        // Ignore unreadable/unsupported file
      }
    }
    persistNow();
  }

  async function removeAttachment(note: Note, attachment: NoteAttachment) {
    note.attachments = note.attachments.filter((a) => a.id !== attachment.id);
    note.updatedAt = new Date().toISOString();
    persistNow();
    try {
      await deleteImageFile(attachment.filename);
    } catch {
      // Ignore cleanup errors
    }
  }

  function handlePaste(e: ClipboardEvent) {
    if (lightboxState) return;
    const target = e.target as HTMLElement | null;
    if (target && !panelEl?.contains(target)) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;

    const images: { blob: Blob; name?: string }[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) images.push({ blob: file, name: file.name });
      }
    }

    if (images.length > 0) {
      e.preventDefault();
      void attachBlobs(images);
    }
  }

  function handleFilePick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      void attachBlobs(files.map((f) => ({ blob: f, name: f.name })));
    }
    input.value = '';
  }

  function handleDragEnter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    dragActive = true;
  }

  function handleDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragActive = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth = 0;
    dragActive = false;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length > 0) {
      void attachBlobs(files.map((f) => ({ blob: f, name: f.name })));
    }
  }

  function resizeTextarea() {
    if (!bodyEl) return;
    bodyEl.style.height = 'auto';
    bodyEl.style.height = `${Math.max(160, bodyEl.scrollHeight)}px`;
  }

  function isPointInPanel(x: number, y: number): boolean {
    if (!panelEl) return false;
    const rect = panelEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Tauri drag-drop coordinates are physical pixels on Windows; accept either physical or CSS match
    const inCss = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const lx = x / dpr;
    const ly = y / dpr;
    const inLogical = lx >= rect.left && lx <= rect.right && ly >= rect.top && ly <= rect.bottom;
    return inCss || inLogical;
  }

  $effect(() => {
    // Load notes and images dir once on mount, purging any deleted notes older than 3 minutes
    let cancelled = false;
    void Promise.all([loadNotes(), getImagesDir()])
      .then(async ([loadedNotes, dir]) => {
        if (cancelled) return;
        const { notes: cleaned } = await purgeExpiredDeletedNotes(loadedNotes);
        if (cancelled) return;
        notes = cleaned;
        imagesDir = dir;
        clockTickMs = Date.now();
        loaded = true;
      })
      .catch(() => {
        if (!cancelled) loaded = true;
      });

    const unsubNotes = subscribeNotesChanged(() => {
      void loadNotes().then((reloaded) => {
        if (!cancelled) {
          notes = reloaded;
          clockTickMs = Date.now();
        }
      });
    });

    return () => {
      cancelled = true;
      unsubNotes();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      if (restoredTimer) {
        clearTimeout(restoredTimer);
        restoredTimer = undefined;
      }
    };
  });

  $effect(() => {
    // Keep countdown live & auto-purge as soon as any soft-deleted note exceeds 3 minutes
    const hasPendingDeleted = notes.some((n) => Boolean(n.deletedAt));
    if (!hasPendingDeleted) return;

    const timer = setInterval(() => {
      const nowMs = Date.now();
      clockTickMs = nowMs;
      const hasExpired = notes.some((n) => {
        if (!n.deletedAt) return false;
        const ms = Date.parse(n.deletedAt);
        return !Number.isFinite(ms) || nowMs - ms >= NOTE_UNDO_WINDOW_MS;
      });
      if (hasExpired) {
        void purgeExpiredDeletedNotes($state.snapshot(notes), nowMs).then((res) => {
          notes = res.notes;
          if (undoToast && !notes.some((n) => n.id === undoToast?.noteId)) {
            undoToast = null;
          }
        });
      }
    }, 1000);

    return () => clearInterval(timer);
  });

  $effect(() => {
    // Listen for Tauri native OS file drops on Windows
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          dragActive = isPointInPanel(payload.position.x, payload.position.y);
        } else if (payload.type === 'leave') {
          dragActive = false;
        } else if (payload.type === 'drop') {
          const inside = isPointInPanel(payload.position.x, payload.position.y);
          dragActive = false;
          if (inside && payload.paths.length > 0) {
            void attachFilePaths(payload.paths);
          }
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Ignore if drag-drop listener unavailable
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  $effect(() => {
    return subscribePlaybook((pb) => {
      const next: Record<string, boolean> = {};
      for (const entry of pb.entries) {
        if (entry.sourceNoteId) next[entry.sourceNoteId] = true;
      }
      playbookNoteIds = next;
    });
  });

  $effect(() => {
    void activeNote?.body;
    if (activeNote && bodyEl) {
      resizeTextarea();
    }
  });
</script>

<svelte:window onpaste={handlePaste} onkeydown={handleWindowKeyDown} />

<PanelShell {theme} title="Notes" onClose={handlePanelClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.75 6h5.5M4.25 9.25h2.75" />
      <path d="M13.7 4.6a2 2 0 0 1 2.8 2.8l-7.1 7.1-3.75.95.95-3.75Z" />
    </svg>
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={panelEl}
    data-notes-panel="true"
    class="notes-panel"
    class:light={theme === 'light'}
    ondragenter={handleDragEnter}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    {#if activeNote}
      <!-- Editor View -->
      <div class="editor-bar">
        <button class="back-button" type="button" onclick={backToList}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.25 5.25 7.5 10l4.75 4.75" />
          </svg>
          <span>Notes</span>
        </button>

        <div class="editor-actions">
          <span class="save-status">
            {playbookSavedId === activeNote.id ? 'In Playbook' : saving ? 'Saving…' : 'Saved'}
          </span>

          <button
            class="icon-action"
            class:starred={Boolean(playbookNoteIds[activeNote.id])}
            type="button"
            aria-label={playbookNoteIds[activeNote.id] ? 'Update in Playbook' : 'Save to Playbook'}
            title={playbookNoteIds[activeNote.id] ? 'Saved in Playbook (click to sync)' : 'Save to Playbook'}
            onclick={() => void handleSaveNoteToPlaybook(activeNote)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m10 3.25 2.05 4.2 4.6.65-3.32 3.25.78 4.6L10 13.75 5.89 15.95l.78-4.6L3.35 8.1l4.6-.65L10 3.25Z" />
            </svg>
          </button>

          <button
            class="icon-action"
            class:pinned={activeNote.pinned}
            type="button"
            aria-label={activeNote.pinned ? 'Unpin note' : 'Pin note'}
            title={activeNote.pinned ? 'Unpin' : 'Pin'}
            aria-pressed={activeNote.pinned}
            onclick={() => togglePin(activeNote.id)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12.5 3.75 16.25 7.5l-1.5 1.5-1.15-.35-2.6 2.6.6 2.65-1.25 1.25-2.75-2.75L4 16l3.6-3.6-2.75-2.75 1.25-1.25 2.65.6 2.6-2.6-.35-1.15 1.5-1.5Z" />
            </svg>
          </button>

          <button
            class="icon-action"
            type="button"
            aria-label="Attach screenshot"
            title="Attach image"
            onclick={() => fileInputEl?.click()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="3" y="4" width="14" height="12" rx="2.5" />
              <circle cx="7.5" cy="8.25" r="1.25" />
              <path d="m4.5 14 3.5-3.5 2.5 2.5 2-2 3 3" />
            </svg>
          </button>

          <button
            class="icon-action danger"
            type="button"
            aria-label="Delete note"
            title="Delete (Ctrl+Z undo for 3m · Shift+Click to delete permanently)"
            onclick={(e) => softDeleteNote(activeNote.id, e.shiftKey)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <ellipse cx="10" cy="5.25" rx="4.75" ry="1.75" />
              <path d="M5.25 5.25l.9 9.4a2.35 2.35 0 0 0 2.35 2.1h3a2.35 2.35 0 0 0 2.35-2.1l.9-9.4" />
              <path d="m8.6 10.35 2.8 2.8m0-2.8-2.8 2.8" />
            </svg>
          </button>
        </div>
      </div>

      <div class="editor-scroll">
        <div class="editor-meta">
          <span class="meta-date">
            {formatShortDate(activeNote.date)} · {formatTime(activeNote.createdAt)}
          </span>

          {#if editingSymbol}
            <input
              bind:this={symbolInputEl}
              class="symbol-input"
              type="text"
              maxlength={16}
              bind:value={symbolDraft}
              onblur={commitSymbolEdit}
              onkeydown={(e) => {
                if (e.key === 'Enter') commitSymbolEdit();
                if (e.key === 'Escape') editingSymbol = false;
              }}
            />
          {:else}
            <button
              class="symbol-chip"
              type="button"
              title="Click to edit symbol"
              onclick={startSymbolEdit}
            >
              <SymbolIcon symbol={activeNote.symbol} size={14} />
              <span>{activeNote.symbol}</span>
            </button>
          {/if}
        </div>

        <input
          bind:this={titleInputEl}
          class="editor-title"
          type="text"
          placeholder="Note title"
          value={activeNote.title}
          oninput={(e) => {
            activeNote.title = (e.currentTarget as HTMLInputElement).value;
            touchNote(activeNote);
          }}
        />

        <textarea
          bind:this={bodyEl}
          class="editor-body"
          placeholder="Write your findings, or press Ctrl+V to paste a screenshot…"
          value={activeNote.body}
          oninput={(e) => {
            activeNote.body = (e.currentTarget as HTMLTextAreaElement).value;
            resizeTextarea();
            touchNote(activeNote);
          }}
        ></textarea>

        {#if activeNote.attachments.length > 0}
          <div
            class="attachments-grid"
            class:single={activeNote.attachments.length === 1}
          >
            {#each activeNote.attachments as att, idx (att.id)}
              <div class="attachment-card">
                <button
                  class="attachment-preview"
                  type="button"
                  aria-label="Open screenshot {idx + 1}"
                  onclick={() => (lightboxState = { index: idx })}
                >
                  <img src={getImageUrl(att.filename, imagesDir)} alt="Chart screenshot" />
                </button>
                <button
                  class="attachment-remove"
                  type="button"
                  aria-label="Remove screenshot"
                  title="Remove"
                  onclick={() => void removeAttachment(activeNote, att)}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m3 3 6 6m0-6-6 6" />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <button
          class="attach-dropzone"
          type="button"
          onclick={() => fileInputEl?.click()}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 4.5v11M4.5 10h11" />
          </svg>
          <span>Paste screenshot (Ctrl+V) or drop image</span>
        </button>
      </div>
    {:else}
      <!-- List View -->
      <div class="toolbar">
        <div class="search-box">
          <svg class="search-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="9" cy="9" r="5.25" />
            <path d="m13 13 3.5 3.5" />
          </svg>
          <input
            class="search-input"
            type="text"
            placeholder="Search notes…"
            bind:value={searchQuery}
          />
          {#if searchQuery}
            <button
              class="search-clear"
              type="button"
              aria-label="Clear search"
              onclick={() => (searchQuery = '')}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="m3 3 6 6m0-6-6 6" />
              </svg>
            </button>
          {/if}
        </div>

        <button class="new-button" type="button" onclick={() => createNewNote(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.25v9.5M3.25 8h9.5" />
          </svg>
          <span>New</span>
        </button>
      </div>

      <div class="tab-pills" role="tablist" aria-label="Notes filter">
        <button
          class="pill"
          class:active={activeTab === 'all'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'all'}
          onclick={() => (activeTab = 'all')}
        >
          All
        </button>

        <button
          class="pill"
          class:active={activeTab === 'symbol'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'symbol'}
          onclick={() => (activeTab = 'symbol')}
        >
          <span>{activeSymbol}</span>
          {#if symbolCount > 0}
            <span class="pill-count">{symbolCount}</span>
          {/if}
        </button>

        <button
          class="pill"
          class:active={activeTab === 'pinned'}
          type="button"
          role="tab"
          aria-selected={activeTab === 'pinned'}
          onclick={() => (activeTab = 'pinned')}
        >
          Pinned
        </button>
      </div>

      <div class="notes-list">
        {#if !loaded}
          <div class="empty-state">Loading notes…</div>
        {:else if groupedNotes.length === 0}
          <div class="empty-state">
            {#if searchQuery.trim()}
              <p>No notes match “{searchQuery.trim()}”</p>
              <button class="empty-action" type="button" onclick={() => (searchQuery = '')}>
                Clear search
              </button>
            {:else if activeTab === 'symbol'}
              <p>No notes for {activeSymbol} yet</p>
              <button class="empty-action" type="button" onclick={() => createNewNote(true)}>
                New {activeSymbol} note
              </button>
            {:else if activeTab === 'pinned'}
              <p>No pinned notes</p>
            {:else}
              <p>No notes yet</p>
              <span class="empty-hint">Click New or paste a screenshot (Ctrl+V)</span>
            {/if}
          </div>
        {:else}
          {#each groupedNotes as group (group.date)}
            <div class="date-heading">{group.heading}</div>

            {#each group.items as note (note.id)}
              <!-- svelte-ignore a11y_interactive_supports_focus -->
              <div
                class="note-row"
                role="button"
                tabindex="0"
                onclick={() => openNote(note.id)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openNote(note.id);
                  }
                }}
              >
                <div class="note-row-top">
                  <div class="note-row-meta">
                    <span class="symbol-pill">
                      <SymbolIcon symbol={note.symbol} size={14} />
                      <span>{note.symbol}</span>
                    </span>
                    <span class="row-time">{formatTime(note.createdAt)}</span>
                  </div>

                  <div class="row-actions">
                    <button
                      class="row-icon-btn"
                      class:is-starred={Boolean(playbookNoteIds[note.id])}
                      type="button"
                      aria-label={playbookNoteIds[note.id] ? 'Saved in Playbook' : 'Save to Playbook'}
                      title={playbookNoteIds[note.id] ? 'Saved in Playbook (click to update)' : 'Save to Playbook'}
                      onclick={(e) => {
                        e.stopPropagation();
                        void handleSaveNoteToPlaybook(note);
                      }}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="m10 3.25 2.05 4.2 4.6.65-3.32 3.25.78 4.6L10 13.75 5.89 15.95l.78-4.6L3.35 8.1l4.6-.65L10 3.25Z" />
                      </svg>
                    </button>

                    <button
                      class="row-icon-btn"
                      class:is-pinned={note.pinned}
                      type="button"
                      aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                      title={note.pinned ? 'Unpin' : 'Pin'}
                      onclick={(e) => {
                        e.stopPropagation();
                        togglePin(note.id);
                      }}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M12.5 3.75 16.25 7.5l-1.5 1.5-1.15-.35-2.6 2.6.6 2.65-1.25 1.25-2.75-2.75L4 16l3.6-3.6-2.75-2.75 1.25-1.25 2.65.6 2.6-2.6-.35-1.15 1.5-1.5Z" />
                      </svg>
                    </button>

                    <button
                      class="row-icon-btn"
                      type="button"
                      aria-label="Delete note"
                      title="Delete (Ctrl+Z undo for 3m · Shift+Click to delete permanently)"
                      onclick={(e) => {
                        e.stopPropagation();
                        softDeleteNote(note.id, e.shiftKey);
                      }}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <ellipse cx="10" cy="5.25" rx="4.75" ry="1.75" />
                        <path d="M5.25 5.25l.9 9.4a2.35 2.35 0 0 0 2.35 2.1h3a2.35 2.35 0 0 0 2.35-2.1l.9-9.4" />
                        <path d="m8.6 10.35 2.8 2.8m0-2.8-2.8 2.8" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div class="note-row-title" class:untitled={!note.title.trim()}>
                  {note.title.trim() || 'Untitled'}
                </div>

                {#if note.body.trim()}
                  <div class="note-row-excerpt">{cleanNoteExcerpt(note.body)}</div>
                {/if}

                {#if note.attachments.length > 0}
                  <div class="row-cover-wrap">
                    <img
                      class="row-cover-img"
                      src={getImageUrl(note.attachments[0].filename, imagesDir)}
                      alt=""
                      loading="lazy"
                    />
                    {#if note.attachments.length > 1}
                      <span class="row-cover-count">+{note.attachments.length - 1}</span>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          {/each}
        {/if}
      </div>
    {/if}

    <input
      bind:this={fileInputEl}
      class="hidden-file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      tabindex="-1"
      aria-hidden="true"
      onchange={handleFilePick}
    />

    {#if dragActive}
      <div class="drop-overlay" aria-hidden="true">
        <div class="drop-box">
          <svg viewBox="0 0 20 20">
            <rect x="3" y="4" width="14" height="12" rx="2.5" />
            <circle cx="7.5" cy="8.25" r="1.25" />
            <path d="m4.5 14 3.5-3.5 2.5 2.5 2-2 3 3" />
          </svg>
          <span>Drop screenshot to attach</span>
        </div>
      </div>
    {/if}

    {#if activeUndoTarget}
      <div class="undo-toast" role="status" aria-live="polite">
        <span class="toast-text" title="Press Ctrl+Z to restore within 3 minutes">
          Deleted “{activeUndoTarget.title}” · {formatCountdown(activeUndoTarget.deletedAtMs, clockTickMs)}
        </span>
        <div class="toast-actions">
          <button
            class="toast-undo"
            type="button"
            title="Restore note (Ctrl+Z)"
            onclick={() => undoDelete(activeUndoTarget.noteId)}
          >
            Undo
          </button>
          <button
            class="toast-purge"
            type="button"
            title="Permanently delete now"
            onclick={() => deletePermanentlyNow(activeUndoTarget.noteId)}
          >
            Delete now
          </button>
        </div>
      </div>
    {:else if restoredBanner}
      <div class="undo-toast" role="status" aria-live="polite">
        <span class="toast-text">{restoredBanner}</span>
      </div>
    {/if}
  </div>
</PanelShell>

{#if lightboxState && activeNote}
  <ImageLightbox
    attachments={activeNote.attachments}
    initialIndex={lightboxState.index}
    {imagesDir}
    metaLabel="{activeNote.symbol} · {formatShortDate(activeNote.date)}"
    onDelete={(att) => void removeAttachment(activeNote, att)}
    onClose={() => (lightboxState = null)}
  />
{/if}

<style>
  .notes-panel {
    --np-bg: var(--dark-bg-panel);
    --np-border: var(--dark-border);
    --np-row-divider: var(--dark-border);
    --np-text: var(--dark-text-primary);
    --np-secondary: var(--dark-text-secondary);
    --np-pill-bg: var(--dark-bg-surface-alt);
    --np-pill-text: var(--dark-text-primary);
    --np-pill-active-bg: var(--dark-cta-bg);
    --np-pill-active-text: var(--dark-cta-fg);
    --np-heading-bg: var(--dark-bg-subtle);
    --np-heading-accent: var(--dark-text-primary);
    --np-hover: var(--dark-hover);
    --np-control-hover: var(--dark-hover-strong);
    --np-toast-bg: var(--dark-bg-toast);
    --np-toast-fg: var(--dark-text-strong);
    --np-toast-border: var(--dark-border-glass);

    position: relative;
    container-type: inline-size;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--np-text);
    background: var(--np-bg);
    transition: color 150ms ease, background-color 150ms ease;
  }

  .notes-panel.light {
    --np-bg: #ffffff;
    --np-border: #e0e3eb;
    --np-row-divider: #f0f2f5;
    --np-text: #131722;
    --np-secondary: #6a6d78;
    --np-pill-bg: #f2f2f2;
    --np-pill-text: #131722;
    --np-pill-active-bg: #222222;
    --np-pill-active-text: #ffffff;
    --np-heading-bg: #f9f9f9;
    --np-heading-accent: #000000;
    --np-hover: rgba(0, 0, 0, 0.03);
    --np-control-hover: rgba(0, 0, 0, 0.04);
    --np-toast-bg: #1e222d;
    --np-toast-fg: #ffffff;
    --np-toast-border: transparent;
  }

  /* Toolbar */
  .toolbar {
    height: 36px;
    flex: 0 0 36px;
    padding: 0 16px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .search-box {
    flex: 1;
    min-width: 0;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--np-border);
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: border-color 150ms ease;
  }

  .search-box:focus-within {
    border-color: var(--np-secondary);
  }

  .search-icon {
    width: 15px;
    height: 15px;
    flex: 0 0 15px;
    fill: none;
    stroke: var(--np-secondary);
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .search-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--np-text);
    font: inherit;
    font-size: 13.5px;
    outline: none;
  }

  .search-input::placeholder {
    color: var(--np-secondary);
  }

  .search-clear {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    display: grid;
    place-items: center;
    color: var(--np-secondary);
    background: transparent;
    cursor: pointer;
  }

  .search-clear:hover {
    color: var(--np-text);
    background: var(--np-control-hover);
  }

  .search-clear svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .new-button {
    height: 36px;
    padding: 0 12px;
    flex: 0 0 auto;
    border: 1px solid var(--np-border);
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--np-text);
    background: transparent;
    font: inherit;
    font-size: 13.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .new-button:hover {
    background: var(--np-control-hover);
  }

  .new-button svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  /* Pill Tabs (same geometry as CalendarPanel) */
  .tab-pills {
    flex: 0 0 auto;
    padding: 0 16px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }

  .pill {
    height: 34px;
    padding: 0 14px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 17px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    color: var(--np-pill-text);
    background: var(--np-pill-bg);
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .pill.active {
    color: var(--np-pill-active-text);
    background: var(--np-pill-active-bg);
  }

  .pill-count {
    font-size: 11.5px;
    opacity: 0.72;
    font-variant-numeric: tabular-nums;
  }

  /* List */
  .notes-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .notes-list::-webkit-scrollbar {
    display: none;
  }

  .date-heading {
    height: 40px;
    margin-left: 16px;
    padding: 0 16px 0 12px;
    display: flex;
    align-items: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--np-text);
    background: var(--np-heading-bg);
    border-left: 3px solid var(--np-heading-accent);
    border-bottom: 1px solid var(--np-border);
    transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
  }

  .note-row {
    padding: 13px 16px 14px;
    border-bottom: 1px solid var(--np-row-divider);
    display: flex;
    flex-direction: column;
    gap: 7px;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .note-row:hover {
    background: var(--np-hover);
  }

  .note-row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .note-row-title {
    font-size: 14px;
    font-weight: 650;
    line-height: 1.32;
    letter-spacing: -0.01em;
    color: var(--np-text);
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .note-row-title.untitled {
    color: var(--np-secondary);
    font-weight: 500;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }

  .row-icon-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--np-secondary);
    background: transparent;
    opacity: 0;
    cursor: pointer;
    transition: opacity 150ms ease, background-color 150ms ease, color 150ms ease;
  }

  .note-row:hover .row-icon-btn,
  .row-icon-btn:focus-visible,
  .row-icon-btn.is-pinned,
  .row-icon-btn.is-starred {
    opacity: 1;
  }

  .row-icon-btn.is-pinned {
    color: var(--np-text);
  }

  .row-icon-btn.is-starred {
    color: #f59e0b;
  }

  .row-icon-btn.is-starred svg path {
    fill: currentColor;
  }

  .row-icon-btn:hover {
    color: var(--np-text);
    background: var(--np-control-hover);
  }

  .row-icon-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .note-row-excerpt {
    font-size: 12.5px;
    line-height: 1.48;
    color: var(--np-secondary);
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .note-row-meta {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .symbol-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px 2px 4px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--np-text);
    background: var(--np-pill-bg);
  }

  .row-time {
    font-size: 11.5px;
    color: var(--np-secondary);
    font-variant-numeric: tabular-nums;
  }

  .row-cover-wrap {
    position: relative;
    margin-top: 2px;
    width: 100%;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--np-border);
    background: var(--np-heading-bg);
  }

  .row-cover-img {
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 184px;
    object-fit: cover;
    object-position: center;
    display: block;
    transition: transform 200ms ease;
  }

  .note-row:hover .row-cover-img {
    transform: scale(1.012);
  }

  .row-cover-count {
    position: absolute;
    right: 8px;
    bottom: 8px;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #ffffff;
    background: rgba(0, 0, 0, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.16);
  }

  /* Empty state */
  .empty-state {
    padding: 56px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--np-secondary);
    font-size: 13px;
  }

  .empty-state p {
    margin: 0;
  }

  .empty-hint {
    font-size: 12px;
    opacity: 0.8;
  }

  .empty-action {
    margin-top: 4px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--np-border);
    border-radius: 8px;
    color: var(--np-text);
    background: transparent;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .empty-action:hover {
    background: var(--np-control-hover);
  }

  /* Editor View */
  .editor-bar {
    height: 40px;
    flex: 0 0 40px;
    padding: 0 12px 0 10px;
    border-bottom: 1px solid var(--np-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }

  .back-button {
    height: 30px;
    padding: 0 8px 0 4px;
    border: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--np-text);
    background: transparent;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .back-button:hover {
    background: var(--np-control-hover);
  }

  .back-button svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .save-status {
    margin-right: 6px;
    font-size: 11.5px;
    color: var(--np-secondary);
  }

  .icon-action {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--np-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .icon-action:hover,
  .icon-action.pinned {
    color: var(--np-text);
  }

  .icon-action:hover {
    background: var(--np-control-hover);
  }

  .icon-action.pinned {
    background: var(--np-pill-bg);
  }

  .icon-action.starred {
    color: #f59e0b;
  }

  .icon-action.starred svg path {
    fill: currentColor;
  }

  .icon-action.danger:hover {
    color: #f23645;
  }

  .icon-action svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .editor-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
    padding: 14px 16px 28px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .editor-scroll::-webkit-scrollbar {
    display: none;
  }

  .editor-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .meta-date {
    font-size: 12px;
    color: var(--np-secondary);
    font-variant-numeric: tabular-nums;
  }

  .symbol-chip {
    height: 24px;
    padding: 0 9px 0 5px;
    border: 0;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--np-text);
    background: var(--np-pill-bg);
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .symbol-chip:hover {
    background: var(--np-control-hover);
  }

  .symbol-input {
    width: 92px;
    height: 22px;
    padding: 0 6px;
    border: 1px solid #2962ff;
    border-radius: 6px;
    color: var(--np-text);
    background: transparent;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    outline: none;
  }

  .editor-title {
    width: 100%;
    padding: 2px 0;
    border: 0;
    color: var(--np-text);
    background: transparent;
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    outline: none;
  }

  .editor-title::placeholder {
    color: var(--np-secondary);
    opacity: 0.7;
  }

  .editor-body {
    width: 100%;
    min-height: 160px;
    padding: 0;
    border: 0;
    resize: none;
    overflow: hidden;
    color: var(--np-text);
    background: transparent;
    font: inherit;
    font-size: 13.5px;
    line-height: 1.6;
    outline: none;
  }

  .editor-body::placeholder {
    color: var(--np-secondary);
    opacity: 0.7;
  }

  /* Attachments */
  .attachments-grid {
    margin-top: 6px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .attachments-grid.single {
    grid-template-columns: 1fr;
  }

  @container (min-width: 480px) {
    .attachments-grid:not(.single) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .attachment-card {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--np-border);
    background: var(--np-heading-bg);
  }

  .attachment-preview {
    width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    display: block;
    cursor: zoom-in;
  }

  .attachment-preview img {
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    display: block;
    transition: transform 200ms ease;
  }

  .attachment-card:hover .attachment-preview img {
    transform: scale(1.012);
  }

  .attachments-grid.single .attachment-preview img {
    aspect-ratio: auto;
    max-height: 280px;
    object-fit: cover;
  }

  .attachment-remove {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: #ffffff;
    background: rgba(0, 0, 0, 0.65);
    opacity: 0;
    cursor: pointer;
    transition: opacity 150ms ease, background-color 150ms ease;
  }

  .attachment-card:hover .attachment-remove,
  .attachment-remove:focus-visible {
    opacity: 1;
  }

  .attachment-remove:hover {
    background: rgba(242, 54, 69, 0.9);
  }

  .attachment-remove svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .attach-dropzone {
    margin-top: 6px;
    height: 38px;
    padding: 0 12px;
    border: 1px dashed var(--np-border);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--np-secondary);
    background: transparent;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
  }

  .attach-dropzone:hover {
    color: var(--np-text);
    background: var(--np-hover);
    border-color: var(--np-secondary);
  }

  .attach-dropzone svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .hidden-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  /* Drag overlay */
  .drop-overlay {
    position: absolute;
    inset: 8px;
    z-index: 20;
    border-radius: 10px;
    background: color-mix(in srgb, var(--np-bg) 88%, transparent);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .drop-box {
    padding: 20px 24px;
    border: 1.5px dashed var(--np-secondary);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--np-text);
    font-size: 13px;
    font-weight: 500;
  }

  .drop-box svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Undo toast */
  .undo-toast {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 25;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--np-toast-border);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--np-toast-fg);
    background: var(--np-toast-bg);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    font-size: 12.5px;
  }

  .toast-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .toast-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .toast-undo {
    padding: 4px 10px;
    border: 0;
    border-radius: 6px;
    color: #ffffff;
    background: #2962ff;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .toast-undo:hover {
    opacity: 0.9;
  }

  .toast-purge {
    padding: 4px 8px;
    border: 1px solid var(--np-toast-border);
    border-radius: 6px;
    color: var(--np-toast-fg);
    background: transparent;
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    opacity: 0.8;
    cursor: pointer;
    transition: opacity 140ms ease, color 140ms ease, border-color 140ms ease;
  }

  .toast-purge:hover {
    opacity: 1;
    color: #f23645;
    border-color: rgba(242, 54, 69, 0.5);
  }

  button:focus-visible {
    outline: 1px solid var(--np-text);
    outline-offset: -2px;
  }
</style>
