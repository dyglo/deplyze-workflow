<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onMount } from 'svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import PanelShell from './PanelShell.svelte';
  import SymbolIcon from '../watchlist/SymbolIcon.svelte';
  import {
    deleteImageFile,
    getImageUrl,
    getImagesDir,
    isSupportedImagePath,
    saveImageFromBlob,
    saveImageFromPath
  } from '../notes/api';
  import { formatShortDate, todayNairobiIso, type NoteAttachment } from '../notes/types';
  import {
    DEFAULT_SETUP_TYPES,
    addCustomSetupType,
    computePlaybookEdge,
    deletePlaybookEntry,
    formatRMultiple,
    getAllSetupTypes,
    subscribePlaybook,
    upsertPlaybookEntry,
    type PlaybookEntry,
    type PlaybookGrade,
    type PlaybookOutcome,
    type PlaybookState
  } from '../playbook/store';
  import { fetchEdgeAudit, type EdgeAuditResponse } from '../insights/api';
  import { appendPreTradeRule } from '../tasks/store';
  import { makeWorkspaceId } from '../workspace/storage';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    onSelectSymbol: (symbol: string, shortName: string) => void;
    onClose: () => void;
  }

  let { theme, activeSymbol, activeFullSymbol, onSelectSymbol, onClose }: Props = $props();

  type FilterTab = 'all' | 'aplus' | 'mistakes' | 'symbol';

  const GRADES: PlaybookGrade[] = ['A+', 'B', 'Mistake'];
  const OUTCOMES: PlaybookOutcome[] = ['Win', 'Loss', 'BE', 'Missed'];

  let playbookState = $state<PlaybookState>({ entries: [], customSetupTypes: [] });
  let imagesDir = $state('');
  let activeFilter = $state<FilterTab>('all');
  let setupFilter = $state<string>('all');
  let setupMenuOpen = $state(false);
  let activeEntryId = $state<string | null>(null);

  let rDraft = $state('');
  let editingSymbol = $state(false);
  let symbolDraft = $state('');
  let addingCustomSetup = $state(false);
  let customSetupDraft = $state('');
  let dragActive = $state(false);
  let lightboxState = $state<{ attachments: NoteAttachment[]; index: number; label: string } | null>(
    null
  );
  let edgeAudit = $state<EdgeAuditResponse | null>(null);
  let auditLoading = $state(false);
  let auditError = $state<string | null>(null);
  let auditOpen = $state(false);
  let ruleAddedState = $state<'idle' | 'added' | 'duplicate'>('idle');

  let panelEl: HTMLDivElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();
  let symbolInputEl: HTMLInputElement | undefined = $state();
  let titleInputEl: HTMLInputElement | undefined = $state();
  let dragDepth = 0;

  const allSetupTypes = $derived(getAllSetupTypes(playbookState));
  const edge = $derived(computePlaybookEdge(playbookState.entries));

  const activeEntry = $derived(
    activeEntryId ? (playbookState.entries.find((e) => e.id === activeEntryId) ?? null) : null
  );

  const symbolMatchCount = $derived(
    playbookState.entries.filter(
      (e) => e.symbol.toUpperCase() === (activeSymbol || '').toUpperCase()
    ).length
  );

  const filteredEntries = $derived.by(() => {
    return playbookState.entries
      .filter((e) => {
        if (activeFilter === 'aplus' && e.grade !== 'A+') return false;
        if (activeFilter === 'mistakes' && e.grade !== 'Mistake') return false;
        if (
          activeFilter === 'symbol' &&
          e.symbol.toUpperCase() !== (activeSymbol || '').toUpperCase()
        ) {
          return false;
        }
        if (setupFilter !== 'all' && e.setupType.toLowerCase() !== setupFilter.toLowerCase()) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  });

  onMount(() => {
    const unsub = subscribePlaybook((s) => {
      playbookState = s;
    });

    void getImagesDir().then((dir) => {
      imagesDir = dir;
    });

    const onDocDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (setupMenuOpen && (!el || !el.closest?.('[data-pb-setup-menu]'))) {
        setupMenuOpen = false;
      }
    };
    window.addEventListener('pointerdown', onDocDown);

    let unlistenDrag: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            dragActive = true;
          } else if (payload.type === 'leave') {
            dragActive = false;
          } else if (payload.type === 'drop') {
            dragActive = false;
            void attachFilePaths(payload.paths);
          }
        })
        .then((fn) => {
          unlistenDrag = fn;
        })
        .catch(() => {
          // ignore
        });
    }

    return () => {
      unsub();
      window.removeEventListener('pointerdown', onDocDown);
      unlistenDrag?.();
    };
  });

  function openEntry(entry: PlaybookEntry) {
    activeEntryId = entry.id;
    rDraft = entry.rMultiple !== null ? String(entry.rMultiple) : '';
    editingSymbol = false;
    addingCustomSetup = false;
  }

  function createNewEntry(focusTitle = true): PlaybookEntry {
    const nowIso = new Date().toISOString();
    const sym = activeSymbol || 'XAUUSD';
    const fullSym = activeFullSymbol || sym;
    const entry: PlaybookEntry = {
      id: makeWorkspaceId('pb'),
      title: '',
      symbol: sym,
      fullSymbol: fullSym,
      date: todayNairobiIso(),
      setupType: DEFAULT_SETUP_TYPES[0],
      grade: activeFilter === 'mistakes' ? 'Mistake' : 'A+',
      outcome: 'Win',
      rMultiple: null,
      notes: '',
      attachments: [],
      sourceKind: 'manual',
      createdAt: nowIso,
      updatedAt: nowIso
    };
    upsertPlaybookEntry(entry);
    openEntry(entry);
    if (focusTitle) {
      queueMicrotask(() => titleInputEl?.focus());
    }
    return entry;
  }

  function updateEntry(entry: PlaybookEntry, patch: Partial<PlaybookEntry>) {
    upsertPlaybookEntry({
      ...entry,
      ...patch,
      updatedAt: new Date().toISOString()
    });
  }

  function parseRInput(raw: string): number | null {
    const cleaned = raw.replace(/,/g, '').replace(/r$/i, '').trim();
    if (!cleaned || cleaned === '-' || cleaned === '+') return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
  }

  function handleRInput(entry: PlaybookEntry, raw: string) {
    rDraft = raw;
    const parsed = parseRInput(raw);
    if (parsed !== entry.rMultiple) {
      updateEntry(entry, { rMultiple: parsed });
    }
  }

  function handleDeleteEntry(entry: PlaybookEntry) {
    deletePlaybookEntry(entry.id);
    if (activeEntryId === entry.id) {
      activeEntryId = null;
    }
  }

  function startSymbolEdit() {
    if (!activeEntry) return;
    symbolDraft = activeEntry.symbol;
    editingSymbol = true;
    queueMicrotask(() => {
      symbolInputEl?.focus();
      symbolInputEl?.select();
    });
  }

  function commitSymbolEdit() {
    if (!activeEntry || !editingSymbol) return;
    const next = symbolDraft.trim().toUpperCase();
    if (next && next !== activeEntry.symbol) {
      updateEntry(activeEntry, { symbol: next, fullSymbol: next });
    }
    editingSymbol = false;
  }

  function submitCustomSetup() {
    if (!activeEntry) return;
    const added = addCustomSetupType(customSetupDraft);
    if (added) {
      updateEntry(activeEntry, { setupType: added });
    }
    customSetupDraft = '';
    addingCustomSetup = false;
  }

  async function attachBlobs(blobs: { blob: Blob; name?: string }[]) {
    if (blobs.length === 0) return;
    let target = activeEntry;
    if (!target) {
      target = createNewEntry(false);
    }
    const nextAttachments = [...target.attachments];
    for (const item of blobs) {
      try {
        const att = await saveImageFromBlob(item.blob, target.id, target.date, item.name);
        nextAttachments.push(att);
      } catch {
        // ignore unsupported image
      }
    }
    updateEntry(target, { attachments: nextAttachments });
  }

  async function attachFilePaths(paths: string[]) {
    const valid = paths.filter(isSupportedImagePath);
    if (valid.length === 0) return;
    let target = activeEntry;
    if (!target) {
      target = createNewEntry(false);
    }
    const nextAttachments = [...target.attachments];
    for (const p of valid) {
      try {
        const att = await saveImageFromPath(p, target.id, target.date);
        nextAttachments.push(att);
      } catch {
        // ignore
      }
    }
    updateEntry(target, { attachments: nextAttachments });
  }

  async function removeAttachment(entry: PlaybookEntry, att: NoteAttachment) {
    updateEntry(entry, {
      attachments: entry.attachments.filter((a) => a.id !== att.id)
    });
    // Preserve shared image files when this entry originated from a Note
    if (entry.sourceKind !== 'note') {
      try {
        await deleteImageFile(att.filename);
      } catch {
        // ignore
      }
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
    if (e.dataTransfer?.types.includes('Files')) {
      dragDepth += 1;
      dragActive = true;
    }
  }

  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
    }
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

  async function runEdgeAudit() {
    if (auditLoading || playbookState.entries.length === 0) return;
    auditOpen = true;
    auditLoading = true;
    auditError = null;
    ruleAddedState = 'idle';
    try {
      const result = await fetchEdgeAudit(playbookState.entries);
      edgeAudit = result;
    } catch (err) {
      auditError = err instanceof Error ? err.message : 'Unable to audit playbook right now';
    }
    auditLoading = false;
  }

  async function injectRuleToPreTradeGate() {
    if (!edgeAudit?.nextWeekRule?.rule) return;
    const res = await appendPreTradeRule(edgeAudit.nextWeekRule.rule);
    ruleAddedState = res.duplicate ? 'duplicate' : res.added ? 'added' : 'idle';
  }
</script>

<svelte:window onpaste={handlePaste} />

<PanelShell {theme} title="Playbook" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.75 15.25s-5-3.1-5-6.6a3 3 0 0 1 5-2.2 3 3 0 0 1 5 2.2c0 3.5-5 6.6-5 6.6Z" />
      <path d="M15.85 7.5h.01" />
      <path d="M15.85 11.15 17.1 12.4l-1.25 1.25-1.25-1.25Z" />
    </svg>
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={panelEl}
    class="playbook-panel"
    class:light={theme === 'light'}
    ondragenter={handleDragEnter}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    {#if activeEntry}
      <!-- Detail / Editor View -->
      <div class="editor-bar">
        <button class="back-btn" type="button" onclick={() => (activeEntryId = null)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.25 5.25 7.5 10l4.75 4.75" />
          </svg>
          <span>Playbook</span>
        </button>

        <div class="editor-actions">
          <button
            class="icon-btn"
            type="button"
            title="Load {activeEntry.symbol} on chart"
            aria-label="Load symbol on chart"
            onclick={() => onSelectSymbol(activeEntry.fullSymbol, activeEntry.symbol)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 13.75 7.75 9.5l3 2.5 5.75-5.75" />
              <path d="M12.75 6.25h3.75V10" />
            </svg>
          </button>

          <button
            class="icon-btn"
            type="button"
            title="Attach screenshot"
            aria-label="Attach screenshot"
            onclick={() => fileInputEl?.click()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="3" y="4" width="14" height="12" rx="2.5" />
              <circle cx="7.5" cy="8.25" r="1.25" />
              <path d="m4.5 14 3.5-3.5 2.5 2.5 2-2 3 3" />
            </svg>
          </button>

          <button
            class="icon-btn danger"
            type="button"
            title="Delete setup"
            aria-label="Delete setup"
            onclick={() => handleDeleteEntry(activeEntry)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <ellipse cx="10" cy="5.25" rx="4.75" ry="1.75" />
              <path d="M5.25 5.25l.9 9.4a2.35 2.35 0 0 0 2.35 2.1h3a2.35 2.35 0 0 0 2.35-2.1l.9-9.4" />
              <path d="m8.6 10.35 2.8 2.8m0-2.8-2.8 2.8" />
            </svg>
          </button>
        </div>
      </div>

      <div class="pb-scroll detail-scroll">
        <div class="detail-meta">
          <span class="meta-date">{formatShortDate(activeEntry.date)}</span>
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
            <button class="symbol-chip" type="button" onclick={startSymbolEdit}>
              <SymbolIcon symbol={activeEntry.symbol} size={14} />
              <span>{activeEntry.symbol}</span>
            </button>
          {/if}
        </div>

        <input
          bind:this={titleInputEl}
          class="detail-title"
          type="text"
          placeholder="Setup title (e.g. NY Open XAUUSD Sweep + CHoCH)"
          value={activeEntry.title}
          oninput={(e) =>
            updateEntry(activeEntry, { title: (e.currentTarget as HTMLInputElement).value })
          }
        />

        <!-- Grade & Outcome + R -->
        <div class="tag-block">
          <div class="tag-row">
            <span class="tag-lbl">Grade</span>
            <div class="chip-group">
              {#each GRADES as g (g)}
                <button
                  class="choice-chip"
                  class:active={activeEntry.grade === g}
                  class:grade-a={g === 'A+'}
                  class:grade-m={g === 'Mistake'}
                  type="button"
                  onclick={() => updateEntry(activeEntry, { grade: g })}
                >
                  {g}
                </button>
              {/each}
            </div>
          </div>

          <div class="tag-row">
            <span class="tag-lbl">Outcome</span>
            <div class="outcome-wrap">
              <div class="chip-group">
                {#each OUTCOMES as o (o)}
                  <button
                    class="choice-chip"
                    class:active={activeEntry.outcome === o}
                    class:out-win={o === 'Win'}
                    class:out-loss={o === 'Loss'}
                    type="button"
                    onclick={() => updateEntry(activeEntry, { outcome: o })}
                  >
                    {o}
                  </button>
                {/each}
              </div>

              <div class="r-input-wrap" title="R-Multiple (e.g. 2.5, -1, 0)">
                <input
                  class="r-input"
                  type="text"
                  inputmode="decimal"
                  placeholder="0.0"
                  value={rDraft}
                  oninput={(e) =>
                    handleRInput(activeEntry, (e.currentTarget as HTMLInputElement).value)
                  }
                />
                <span class="r-unit">R</span>
              </div>
            </div>
          </div>

          <div class="tag-row setup-row">
            <span class="tag-lbl">Setup</span>
            <div class="setup-chips">
              {#each allSetupTypes as st (st)}
                <button
                  class="setup-chip"
                  class:active={activeEntry.setupType.toLowerCase() === st.toLowerCase()}
                  type="button"
                  onclick={() => updateEntry(activeEntry, { setupType: st })}
                >
                  {st}
                </button>
              {/each}

              {#if addingCustomSetup}
                <input
                  class="custom-setup-input"
                  type="text"
                  placeholder="Setup name..."
                  maxlength={36}
                  bind:value={customSetupDraft}
                  onblur={submitCustomSetup}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') submitCustomSetup();
                    if (e.key === 'Escape') {
                      addingCustomSetup = false;
                      customSetupDraft = '';
                    }
                  }}
                />
              {:else}
                <button
                  class="setup-chip add-chip"
                  type="button"
                  onclick={() => {
                    addingCustomSetup = true;
                    customSetupDraft = '';
                  }}
                >
                  + Custom
                </button>
              {/if}
            </div>
          </div>
        </div>

        <!-- Screenshots -->
        {#if activeEntry.attachments.length > 0}
          <div class="att-grid" class:single={activeEntry.attachments.length === 1}>
            {#each activeEntry.attachments as att, idx (att.id)}
              <div class="att-card">
                <button
                  class="att-preview"
                  type="button"
                  aria-label="Open screenshot {idx + 1}"
                  onclick={() =>
                    (lightboxState = {
                      attachments: activeEntry.attachments,
                      index: idx,
                      label: `${activeEntry.symbol} · ${activeEntry.setupType || activeEntry.grade}`
                    })
                  }
                >
                  <img src={getImageUrl(att.filename, imagesDir)} alt="Setup chart screenshot" />
                </button>
                <button
                  class="att-remove"
                  type="button"
                  aria-label="Remove screenshot"
                  onclick={() => void removeAttachment(activeEntry, att)}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m3 3 6 6m0-6-6 6" />
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <button class="dropzone-btn" type="button" onclick={() => fileInputEl?.click()}>
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 3.75v10.5M3.75 9h10.5" />
          </svg>
          <span>Paste chart screenshot (Ctrl+V) or drop image</span>
        </button>

        <!-- Execution / Lesson Notes -->
        <div class="notes-block">
          <span class="tag-lbl">Execution & Lesson Notes</span>
          <textarea
            class="notes-area"
            rows={7}
            placeholder="Entry trigger, HTF confluence, execution quality, or lesson learned..."
            value={activeEntry.notes}
            oninput={(e) =>
              updateEntry(activeEntry, { notes: (e.currentTarget as HTMLTextAreaElement).value })
            }
          ></textarea>
        </div>
      </div>
    {:else}
      <!-- List View -->
      <!-- Quiet Edge Summary Bar -->
      <div class="edge-bar">
        {#if edge.totalLogged === 0}
          <span class="edge-muted">Star a Note or AI reply, or log your first A+ setup</span>
        {:else}
          <div class="edge-metrics">
            <span class="edge-stat">{edge.totalLogged} logged</span>
            {#if edge.winRatePct !== null}
              <span class="edge-dot">·</span>
              <span class="edge-stat">{edge.winRatePct}% Win</span>
            {/if}
            {#if edge.totalR !== null}
              <span class="edge-dot">·</span>
              <span
                class="edge-stat"
                class:pos={edge.totalR > 0}
                class:neg={edge.totalR < 0}
              >
                {formatRMultiple(edge.totalR)}
              </span>
            {/if}
            {#if edge.bestSetup}
              <span class="edge-dot">·</span>
              <span class="edge-best" title="Best setup: {edge.bestSetup}">Best: {edge.bestSetup}</span>
            {/if}
          </div>

          <button
            class="audit-trigger"
            class:active={auditOpen}
            type="button"
            disabled={auditLoading}
            title="Run structured AI edge & leak diagnosis across your Playbook"
            onclick={() => void runEdgeAudit()}
          >
            {auditLoading ? 'Auditing...' : 'Audit Edge'}
          </button>
        {/if}
      </div>

      {#if auditOpen}
        <div class="audit-card">
          <div class="audit-head">
            <div class="audit-title-wrap">
              <span class="audit-title">Edge Diagnosis</span>
              {#if edgeAudit}
                <span class="audit-meta">{edgeAudit.analyzedCount} trades</span>
              {/if}
            </div>
            <div class="audit-actions">
              <button
                class="audit-icon-btn"
                type="button"
                title="Re-run edge audit"
                aria-label="Re-run edge audit"
                disabled={auditLoading}
                onclick={() => void runEdgeAudit()}
              >
                <svg class:spin={auditLoading} viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13 8a5 5 0 1 1-1.3-3.36" />
                  <path d="M13 3.25v2.75h-2.75" />
                </svg>
              </button>
              <button
                class="audit-icon-btn"
                type="button"
                title="Close diagnosis"
                aria-label="Close diagnosis"
                onclick={() => (auditOpen = false)}
              >
                ×
              </button>
            </div>
          </div>

          {#if auditLoading && !edgeAudit}
            <div class="audit-status">Analyzing setup expectancy, R-multiples & mistake notes...</div>
          {:else if auditError && !edgeAudit}
            <div class="audit-status">{auditError}</div>
          {:else if edgeAudit}
            <div class="audit-section">
              <div class="audit-k-row">
                <span class="audit-dot edge"></span>
                <span class="audit-k">True Edge</span>
              </div>
              <div class="audit-h">{edgeAudit.trueEdge.headline}</div>
              <div class="audit-d">{edgeAudit.trueEdge.detail}</div>
            </div>

            <div class="audit-section">
              <div class="audit-k-row">
                <span class="audit-dot leak"></span>
                <span class="audit-k">Primary Leak</span>
              </div>
              <div class="audit-h">{edgeAudit.primaryLeak.headline}</div>
              <div class="audit-d">{edgeAudit.primaryLeak.detail}</div>
            </div>

            <div class="audit-section rule-box">
              <div class="audit-k-row">
                <span class="audit-dot rule"></span>
                <span class="audit-k">Rule for Next Week</span>
              </div>
              <div class="audit-h">{edgeAudit.nextWeekRule.rule}</div>
              <div class="audit-d">{edgeAudit.nextWeekRule.rationale}</div>
              <button
                class="inject-rule-btn"
                class:done={ruleAddedState === 'added' || ruleAddedState === 'duplicate'}
                type="button"
                onclick={() => void injectRuleToPreTradeGate()}
              >
                {#if ruleAddedState === 'added'}
                  ✓ Added to Pre-Trade Gate
                {:else if ruleAddedState === 'duplicate'}
                  ✓ Already in Pre-Trade Gate
                {:else}
                  + Add to Pre-Trade Gate
                {/if}
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Filter Row + New -->
      <div class="pb-toolbar">
        <div class="filter-pills" role="tablist" aria-label="Playbook filter">
          <button
            class="pill"
            class:active={activeFilter === 'all'}
            type="button"
            onclick={() => (activeFilter = 'all')}
          >
            All
          </button>
          <button
            class="pill"
            class:active={activeFilter === 'aplus'}
            type="button"
            onclick={() => (activeFilter = 'aplus')}
          >
            A+
          </button>
          <button
            class="pill"
            class:active={activeFilter === 'mistakes'}
            type="button"
            onclick={() => (activeFilter = 'mistakes')}
          >
            Mistakes
          </button>
          <button
            class="pill"
            class:active={activeFilter === 'symbol'}
            type="button"
            onclick={() => (activeFilter = 'symbol')}
          >
            <span>{activeSymbol || 'XAUUSD'}</span>
            {#if symbolMatchCount > 0}
              <span class="pill-cnt">{symbolMatchCount}</span>
            {/if}
          </button>
        </div>

        <button class="new-btn" type="button" onclick={() => createNewEntry(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.25v9.5M3.25 8h9.5" />
          </svg>
          <span>New</span>
        </button>
      </div>

      <!-- Subtle Setup Type filter row -->
      <div class="setup-filter-bar">
        <div class="setup-menu-anchor" data-pb-setup-menu>
          <button
            class="setup-filter-trigger"
            type="button"
            onclick={() => (setupMenuOpen = !setupMenuOpen)}
          >
            <span>Setup: <strong>{setupFilter === 'all' ? 'All types' : setupFilter}</strong></span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
            </svg>
          </button>

          {#if setupMenuOpen}
            <div class="setup-popover">
              <button
                class="pop-opt"
                class:active={setupFilter === 'all'}
                type="button"
                onclick={() => {
                  setupFilter = 'all';
                  setupMenuOpen = false;
                }}
              >
                All setup types
              </button>
              {#each allSetupTypes as st (st)}
                <button
                  class="pop-opt"
                  class:active={setupFilter.toLowerCase() === st.toLowerCase()}
                  type="button"
                  onclick={() => {
                    setupFilter = st;
                    setupMenuOpen = false;
                  }}
                >
                  {st}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        {#if setupFilter !== 'all'}
          <button class="clear-setup" type="button" onclick={() => (setupFilter = 'all')}>
            Clear
          </button>
        {/if}
      </div>

      <!-- Cards List -->
      <div class="pb-scroll list-scroll">
        {#if filteredEntries.length === 0}
          <div class="empty-stage">
            <p class="empty-title">
              {#if playbookState.entries.length === 0}
                Your A+ Playbook is empty
              {:else}
                No setups match this filter
              {/if}
            </p>
            <p class="empty-sub">
              {#if playbookState.entries.length === 0}
                Star notes or AI analyses, paste a chart screenshot (Ctrl+V), or log a setup directly.
              {:else}
                Try switching filters or log a new setup.
              {/if}
            </p>
            <button class="empty-cta" type="button" onclick={() => createNewEntry(true)}>
              Log setup
            </button>
          </div>
        {:else}
          <div class="cards-list">
            {#each filteredEntries as entry (entry.id)}
              {@const rStr = formatRMultiple(entry.rMultiple)}
              <!-- svelte-ignore a11y_interactive_supports_focus -->
              <div
                class="pb-card"
                role="button"
                tabindex="0"
                onclick={() => openEntry(entry)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEntry(entry);
                  }
                }}
              >
                {#if entry.attachments.length > 0}
                  <button
                    class="card-thumb"
                    type="button"
                    aria-label="Preview screenshot"
                    onclick={(e) => {
                      e.stopPropagation();
                      lightboxState = {
                        attachments: entry.attachments,
                        index: 0,
                        label: `${entry.symbol} · ${entry.setupType || entry.grade}`
                      };
                    }}
                  >
                    <img
                      src={getImageUrl(entry.attachments[0].filename, imagesDir)}
                      alt="Trade setup"
                    />
                    {#if entry.attachments.length > 1}
                      <span class="thumb-badge">+{entry.attachments.length - 1}</span>
                    {/if}
                  </button>
                {/if}

                <div class="card-body">
                  <div class="card-top">
                    <div class="card-sym-wrap">
                      <SymbolIcon symbol={entry.symbol} size={15} />
                      <span class="card-sym">{entry.symbol}</span>
                      <span
                        class="grade-pill"
                        class:aplus={entry.grade === 'A+'}
                        class:mistake={entry.grade === 'Mistake'}
                      >
                        {entry.grade}
                      </span>
                    </div>

                    <div class="card-right">
                      <span
                        class="outcome-tag"
                        class:win={entry.outcome === 'Win'}
                        class:loss={entry.outcome === 'Loss'}
                      >
                        {entry.outcome}{#if rStr} {rStr}{/if}
                      </span>

                      <button
                        class="card-del"
                        type="button"
                        title="Delete setup"
                        aria-label="Delete setup"
                        onclick={(e) => {
                          e.stopPropagation();
                          handleDeleteEntry(entry);
                        }}
                      >
                        <svg viewBox="0 0 14 14" aria-hidden="true">
                          <path d="m3.5 3.5 7 7m0-7-7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div class="card-title">{entry.title.trim() || `${entry.symbol} Setup`}</div>

                  {#if entry.notes.trim()}
                    <div class="card-excerpt">{entry.notes.trim()}</div>
                  {/if}

                  <div class="card-foot">
                    {#if entry.setupType}
                      <span class="setup-tag">{entry.setupType}</span>
                    {/if}
                    <span class="card-date">{formatShortDate(entry.date)}</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if dragActive}
      <div class="drop-overlay" aria-hidden="true">
        <span>Drop chart screenshot to attach</span>
      </div>
    {/if}

    <input
      bind:this={fileInputEl}
      class="hidden-file"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      onchange={handleFilePick}
    />
  </div>
</PanelShell>

{#if lightboxState}
  <ImageLightbox
    attachments={lightboxState.attachments}
    initialIndex={lightboxState.index}
    {imagesDir}
    metaLabel={lightboxState.label}
    onClose={() => (lightboxState = null)}
  />
{/if}

<style>
  .playbook-panel {
    --pb-bg: #000000;
    --pb-surface: #0e1118;
    --pb-surface-alt: #141822;
    --pb-border: #252a36;
    --pb-border-soft: rgba(255, 255, 255, 0.07);
    --pb-text: #e6e9f0;
    --pb-secondary: #868993;
    --pb-hover: rgba(255, 255, 255, 0.045);
    --pb-active-bg: #e6e9f0;
    --pb-active-fg: #0b0d12;
    --pb-popover-bg: rgba(18, 18, 18, 0.86);

    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--pb-text);
    background: var(--pb-bg);
  }

  .playbook-panel.light {
    --pb-bg: #ffffff;
    --pb-surface: #f7f8fa;
    --pb-surface-alt: #eff1f5;
    --pb-border: #dfe3eb;
    --pb-border-soft: #eef0f4;
    --pb-text: #131722;
    --pb-secondary: #6a6d78;
    --pb-hover: rgba(0, 0, 0, 0.035);
    --pb-active-bg: #131722;
    --pb-active-fg: #ffffff;
    --pb-popover-bg: #ffffff;
  }

  .edge-bar {
    margin: 2px 14px 8px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--pb-border-soft);
    background: var(--pb-surface);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }

  .edge-muted {
    color: var(--pb-secondary);
  }

  .edge-stat {
    font-weight: 600;
    color: var(--pb-text);
  }

  .edge-stat.pos {
    color: #089981;
  }

  .edge-stat.neg {
    color: #f23645;
  }

  .edge-dot {
    color: var(--pb-secondary);
    opacity: 0.6;
  }

  .edge-best {
    color: var(--pb-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 150px;
  }

  .pb-toolbar {
    padding: 0 14px 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
  }

  .filter-pills {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .pill {
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--pb-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .pill:hover {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .pill.active {
    background: var(--pb-surface-alt);
    color: var(--pb-text);
    font-weight: 600;
  }

  .pill-cnt {
    font-size: 10.5px;
    opacity: 0.72;
    font-variant-numeric: tabular-nums;
  }

  .new-btn {
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 7px;
    background: var(--pb-active-bg);
    color: var(--pb-active-fg);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .new-btn svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }

  .setup-filter-bar {
    padding: 0 14px 8px;
    border-bottom: 1px solid var(--pb-border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex: 0 0 auto;
  }

  .setup-menu-anchor {
    position: relative;
  }

  .setup-filter-trigger {
    height: 24px;
    padding: 0 7px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--pb-secondary);
    font: inherit;
    font-size: 11.5px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }

  .setup-filter-trigger strong {
    color: var(--pb-text);
    font-weight: 600;
  }

  .setup-filter-trigger:hover {
    background: var(--pb-hover);
  }

  .setup-filter-trigger svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .setup-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 185px;
    padding: 5px;
    border-radius: 10px;
    border: 1px solid var(--pb-border);
    background: var(--pb-popover-bg);
    -webkit-backdrop-filter: blur(22px) saturate(135%);
    backdrop-filter: blur(22px) saturate(135%);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: 25;
  }

  .pop-opt {
    border: 0;
    padding: 6px 9px;
    border-radius: 6px;
    background: transparent;
    color: var(--pb-text);
    text-align: left;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .pop-opt:hover,
  .pop-opt.active {
    background: var(--pb-hover);
  }

  .pop-opt.active {
    font-weight: 600;
  }

  .clear-setup {
    border: 0;
    padding: 2px 6px;
    border-radius: 5px;
    background: transparent;
    color: var(--pb-secondary);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .clear-setup:hover {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .pb-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .pb-scroll::-webkit-scrollbar {
    display: none;
  }

  .list-scroll {
    padding: 10px 14px 18px;
  }

  .empty-stage {
    padding: 46px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
  }

  .empty-title {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
  }

  .empty-sub {
    margin: 0;
    max-width: 245px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--pb-secondary);
  }

  .empty-cta {
    margin-top: 6px;
    height: 32px;
    padding: 0 15px;
    border: 0;
    border-radius: 8px;
    background: var(--pb-active-bg);
    color: var(--pb-active-fg);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .cards-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pb-card {
    border-radius: 10px;
    border: 1px solid var(--pb-border-soft);
    background: var(--pb-surface);
    overflow: hidden;
    cursor: pointer;
    transition: border-color 140ms ease, background-color 140ms ease;
  }

  .pb-card:hover {
    border-color: var(--pb-border);
  }

  .card-thumb {
    position: relative;
    width: 100%;
    height: 118px;
    padding: 0;
    border: 0;
    display: block;
    background: #080a0f;
    cursor: zoom-in;
    overflow: hidden;
  }

  .card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .thumb-badge {
    position: absolute;
    right: 8px;
    bottom: 8px;
    padding: 2px 6px;
    border-radius: 5px;
    background: rgba(12, 12, 14, 0.78);
    color: #f0f0f0;
    font-size: 10.5px;
    font-weight: 600;
  }

  .card-body {
    padding: 10px 11px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .card-sym-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .card-sym {
    font-size: 12px;
    font-weight: 700;
  }

  .grade-pill {
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 700;
    background: var(--pb-surface-alt);
    color: var(--pb-secondary);
  }

  .grade-pill.aplus {
    background: rgba(41, 98, 255, 0.16);
    color: #5b8cff;
  }

  .playbook-panel.light .grade-pill.aplus {
    color: #2962ff;
  }

  .grade-pill.mistake {
    background: rgba(242, 54, 69, 0.14);
    color: #f23645;
  }

  .card-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .outcome-tag {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--pb-secondary);
    font-variant-numeric: tabular-nums;
  }

  .outcome-tag.win {
    color: #089981;
  }

  .outcome-tag.loss {
    color: #f23645;
  }

  .card-del {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--pb-secondary);
    display: grid;
    place-items: center;
    opacity: 0;
    cursor: pointer;
    transition: opacity 120ms ease, color 120ms ease;
  }

  .pb-card:hover .card-del,
  .card-del:focus-visible {
    opacity: 1;
  }

  .card-del:hover {
    color: #f23645;
  }

  .card-del svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .card-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-excerpt {
    font-size: 12px;
    line-height: 1.4;
    color: var(--pb-secondary);
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-foot {
    margin-top: 2px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .setup-tag {
    padding: 2px 7px;
    border-radius: 5px;
    background: var(--pb-surface-alt);
    color: var(--pb-secondary);
    font-size: 11px;
    font-weight: 500;
  }

  .card-date {
    font-size: 11px;
    color: var(--pb-secondary);
    margin-left: auto;
  }

  /* Detail Editor View */
  .editor-bar {
    height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--pb-border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 0 36px;
  }

  .back-btn {
    border: 0;
    padding: 4px 6px 4px 2px;
    border-radius: 6px;
    background: transparent;
    color: var(--pb-text);
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
  }

  .back-btn:hover {
    background: var(--pb-hover);
  }

  .back-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .icon-btn {
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--pb-secondary);
    background: transparent;
    cursor: pointer;
  }

  .icon-btn:hover {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .icon-btn.danger:hover {
    color: #f23645;
  }

  .icon-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .detail-scroll {
    padding: 12px 14px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .detail-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .meta-date {
    font-size: 11.5px;
    color: var(--pb-secondary);
  }

  .symbol-chip {
    height: 24px;
    padding: 0 8px 0 5px;
    border: 1px solid var(--pb-border-soft);
    border-radius: 999px;
    background: var(--pb-surface);
    color: var(--pb-text);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .symbol-input {
    width: 96px;
    height: 24px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid var(--pb-border);
    background: var(--pb-surface);
    color: var(--pb-text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    outline: none;
  }

  .detail-title {
    width: 100%;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--pb-text);
    font: inherit;
    font-size: 15px;
    font-weight: 700;
    outline: none;
  }

  .detail-title::placeholder {
    color: var(--pb-secondary);
    font-weight: 500;
  }

  .tag-block {
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--pb-border-soft);
    background: var(--pb-surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .tag-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .tag-lbl {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pb-secondary);
  }

  .chip-group {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .choice-chip {
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--pb-border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--pb-secondary);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .choice-chip:hover {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .choice-chip.active {
    border-color: var(--pb-border);
    background: var(--pb-surface-alt);
    color: var(--pb-text);
  }

  .choice-chip.active.grade-a {
    border-color: rgba(41, 98, 255, 0.4);
    background: rgba(41, 98, 255, 0.16);
    color: #5b8cff;
  }

  .playbook-panel.light .choice-chip.active.grade-a {
    color: #2962ff;
  }

  .choice-chip.active.grade-m,
  .choice-chip.active.out-loss {
    border-color: rgba(242, 54, 69, 0.35);
    background: rgba(242, 54, 69, 0.14);
    color: #f23645;
  }

  .choice-chip.active.out-win {
    border-color: rgba(8, 153, 129, 0.35);
    background: rgba(8, 153, 129, 0.15);
    color: #089981;
  }

  .outcome-wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .r-input-wrap {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid var(--pb-border);
    background: var(--pb-bg);
    gap: 3px;
  }

  .r-input {
    width: 44px;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--pb-text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    text-align: right;
    font-variant-numeric: tabular-nums;
    outline: none;
  }

  .r-unit {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--pb-secondary);
  }

  .setup-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .setup-chip {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--pb-border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--pb-secondary);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .setup-chip:hover {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .setup-chip.active {
    border-color: var(--pb-active-bg);
    background: var(--pb-active-bg);
    color: var(--pb-active-fg);
    font-weight: 600;
  }

  .setup-chip.add-chip {
    border-style: dashed;
  }

  .custom-setup-input {
    height: 24px;
    width: 120px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid var(--pb-border);
    background: var(--pb-bg);
    color: var(--pb-text);
    font: inherit;
    font-size: 11.5px;
    outline: none;
  }

  .att-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .att-grid.single {
    grid-template-columns: 1fr;
  }

  .att-card {
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--pb-border-soft);
    background: #080a0f;
  }

  .att-preview {
    width: 100%;
    padding: 0;
    border: 0;
    display: block;
    background: transparent;
    cursor: zoom-in;
  }

  .att-preview img {
    width: 100%;
    max-height: 190px;
    object-fit: cover;
    display: block;
  }

  .att-remove {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(12, 12, 14, 0.78);
    color: #f0f0f0;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .att-remove svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }

  .dropzone-btn {
    height: 34px;
    border: 1px dashed var(--pb-border);
    border-radius: 8px;
    background: transparent;
    color: var(--pb-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .dropzone-btn:hover {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .dropzone-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .notes-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .notes-area {
    width: 100%;
    padding: 9px 10px;
    border-radius: 8px;
    border: 1px solid var(--pb-border-soft);
    background: var(--pb-surface);
    color: var(--pb-text);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
  }

  .notes-area:focus {
    border-color: var(--pb-border);
  }

  .drop-overlay {
    position: absolute;
    inset: 10px;
    border-radius: 10px;
    border: 1.5px dashed #2962ff;
    background: rgba(18, 18, 18, 0.86);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    display: grid;
    place-items: center;
    font-size: 13px;
    font-weight: 600;
    color: #f0f0f0;
    pointer-events: none;
    z-index: 30;
  }

  .hidden-file {
    display: none;
  }

  .edge-metrics {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    min-width: 0;
    flex: 1;
  }

  .audit-trigger {
    margin-left: auto;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--pb-border);
    border-radius: 6px;
    background: var(--pb-surface);
    color: var(--pb-text);
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
    flex: 0 0 auto;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .audit-trigger:hover:not(:disabled),
  .audit-trigger.active {
    background: var(--pb-surface-alt);
    border-color: var(--pb-secondary);
  }

  .audit-trigger:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .audit-card {
    margin: 0 14px 10px;
    padding: 10px 11px;
    border-radius: 10px;
    border: 1px solid var(--pb-border);
    background: var(--pb-surface);
    display: flex;
    flex-direction: column;
    gap: 9px;
    flex: 0 0 auto;
  }

  .audit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .audit-title-wrap {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .audit-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--pb-text);
  }

  .audit-meta {
    font-size: 10.5px;
    color: var(--pb-secondary);
    font-variant-numeric: tabular-nums;
  }

  .audit-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .audit-icon-btn {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--pb-secondary);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .audit-icon-btn:hover:not(:disabled) {
    color: var(--pb-text);
    background: var(--pb-hover);
  }

  .audit-icon-btn svg {
    width: 12.5px;
    height: 12.5px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .audit-icon-btn svg.spin {
    animation: pb-spin 0.9s linear infinite;
  }

  @keyframes pb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .audit-status {
    font-size: 11.5px;
    color: var(--pb-secondary);
    line-height: 1.4;
  }

  .audit-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .audit-k-row {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .audit-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 6px;
  }

  .audit-dot.edge {
    background: #089981;
  }

  .audit-dot.leak {
    background: #f59e0b;
  }

  .audit-dot.rule {
    background: #2962ff;
  }

  .audit-k {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pb-secondary);
  }

  .audit-h {
    font-size: 12px;
    font-weight: 600;
    color: var(--pb-text);
    line-height: 1.35;
  }

  .audit-d {
    font-size: 11px;
    color: var(--pb-secondary);
    line-height: 1.38;
  }

  .rule-box {
    padding-top: 8px;
    border-top: 1px solid var(--pb-border-soft);
    gap: 3px;
  }

  .inject-rule-btn {
    margin-top: 5px;
    height: 27px;
    padding: 0 10px;
    border: 1px solid var(--pb-border);
    border-radius: 7px;
    background: var(--pb-surface-alt);
    color: var(--pb-text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
  }

  .inject-rule-btn:hover {
    border-color: var(--pb-secondary);
  }

  .inject-rule-btn.done {
    border-color: rgba(8, 153, 129, 0.45);
    background: rgba(8, 153, 129, 0.14);
    color: #089981;
  }
</style>
