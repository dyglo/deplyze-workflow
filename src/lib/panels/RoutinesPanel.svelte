<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import {
    RITUAL_GROUPS,
    computeSessionsSnapshot,
    computeWeeklyConsistency,
    createDefaultRoutinesState,
    createRitualItem,
    getLocalDateIso,
    loadRoutinesState,
    reconcileRoutinesDay,
    saveRoutinesState,
    syncTodayHistory,
    type RitualGroupId,
    type RoutinesState
  } from '../routines/store';

  interface Props {
    theme: 'dark' | 'light';
    onClose: () => void;
  }

  let { theme, onClose }: Props = $props();

  let routinesState = $state<RoutinesState>(createDefaultRoutinesState());
  let nowTick = $state(new Date());
  let addingGroup = $state<RitualGroupId | null>(null);
  let newRitualLabel = $state('');

  const snapshot = $derived(computeSessionsSnapshot(nowTick));
  const weekly = $derived(computeWeeklyConsistency(routinesState, nowTick, snapshot.timeZone));

  const doneCount = $derived(routinesState.items.filter((i) => i.done).length);
  const totalCount = $derived(routinesState.items.length);
  const progressPct = $derived(totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0);

  onMount(() => {
    void loadRoutinesState().then((loaded) => {
      routinesState = loaded;
    });

    const timer = setInterval(() => {
      const now = new Date();
      nowTick = now;
      const todayIso = getLocalDateIso(now);
      if (routinesState.activeDate !== todayIso) {
        const { state: next, rolledOver } = reconcileRoutinesDay(routinesState, todayIso);
        if (rolledOver) {
          routinesState = next;
          void saveRoutinesState(next);
        }
      }
    }, 30_000);

    return () => {
      clearInterval(timer);
    };
  });

  function commit(next: RoutinesState) {
    const synced = syncTodayHistory(next);
    routinesState = synced;
    void saveRoutinesState(synced);
  }

  function toggleRitual(id: string) {
    commit({
      ...routinesState,
      items: routinesState.items.map((item) =>
        item.id === id ? { ...item, done: !item.done } : item
      )
    });
  }

  function removeRitual(id: string) {
    commit({
      ...routinesState,
      items: routinesState.items.filter((item) => item.id !== id)
    });
  }

  function resetToday() {
    commit({
      ...routinesState,
      items: routinesState.items.map((item) => ({ ...item, done: false }))
    });
  }

  function openAddFor(group: RitualGroupId) {
    addingGroup = addingGroup === group ? null : group;
    newRitualLabel = '';
  }

  function submitNewRitual(group: RitualGroupId) {
    const label = newRitualLabel.trim();
    if (!label) return;
    commit({
      ...routinesState,
      items: [...routinesState.items, createRitualItem(group, label)]
    });
    newRitualLabel = '';
    addingGroup = null;
  }

  function shortTzName(tz: string): string {
    const parts = tz.split('/');
    return (parts[parts.length - 1] ?? tz).replace(/_/g, ' ');
  }
</script>

<PanelShell {theme} title="Routines" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11 6.25h2.5a3.75 3.75 0 0 1 0 7.5h-7a3.75 3.75 0 0 1 0-7.5" />
      <circle cx="7.25" cy="6.25" r="1.15" />
    </svg>
  {/snippet}

  <div class="routines-panel" class:light={theme === 'light'}>
    <div class="rt-scroll">
      <!-- Live Sessions Clock -->
      <section class="card sessions-card">
        <div class="clock-head">
          <div class="clock-left">
            <span class="clock-time">{snapshot.localTimeLabel}</span>
            <span class="clock-sub">{shortTzName(snapshot.timeZone)} · {snapshot.localDateLabel}</span>
          </div>

          <div class="clock-badges">
            {#if snapshot.isWeekendClosed}
              <span class="sess-badge closed">Weekend</span>
            {:else if snapshot.overlapActive}
              <span class="sess-badge overlap">LDN–NY Overlap</span>
            {:else if snapshot.activeNames.length > 0}
              {#each snapshot.activeNames as name (name)}
                <span class="sess-badge active">{name}</span>
              {/each}
            {:else}
              <span class="sess-badge quiet">Off-Session</span>
            {/if}
          </div>
        </div>

        <div class="countdown-row">
          <span class="countdown-dot" class:live={!snapshot.isWeekendClosed && snapshot.activeNames.length > 0}></span>
          <span class="countdown-text">
            {#if snapshot.isWeekendClosed}
              Markets closed · {snapshot.nextEventLabel}
            {:else}
              {snapshot.nextEventLabel}
            {/if}
          </span>
        </div>

        <!-- Compact 24-hour local timeline -->
        <div class="timeline-wrap" aria-label="24-hour trading sessions timeline">
          <div class="timeline-rows">
            {#each snapshot.sessions as sess (sess.id)}
              <div class="tl-row">
                <div class="tl-meta">
                  <span class="tl-name" class:live={sess.active}>
                    <span class="tl-dot" style:background={sess.color}></span>
                    {sess.name}
                  </span>
                  <span class="tl-hours">{sess.localRangeLabel}</span>
                </div>
                <div class="tl-track">
                  {#each sess.segments as seg, idx (idx)}
                    <div
                      class="tl-bar"
                      class:live={sess.active}
                      style:left="{seg.startPct}%"
                      style:width="{seg.widthPct}%"
                      style:--bar-color={sess.color}
                    ></div>
                  {/each}
                  <div class="tl-now" style:left="{snapshot.nowPct}%"></div>
                </div>
              </div>
            {/each}

            {#if snapshot.overlapRangeLabel}
              <div class="tl-row overlap-row">
                <div class="tl-meta">
                  <span class="tl-name" class:live={snapshot.overlapActive}>
                    <span class="tl-dot overlap-dot"></span>
                    LDN–NY
                  </span>
                  <span class="tl-hours">{snapshot.overlapRangeLabel}</span>
                </div>
                <div class="tl-track">
                  {#each snapshot.overlapSegments as seg, idx (idx)}
                    <div
                      class="tl-bar"
                      class:live={snapshot.overlapActive}
                      style:left="{seg.startPct}%"
                      style:width="{seg.widthPct}%"
                      style:--bar-color="#f59e0b"
                    ></div>
                  {/each}
                  <div class="tl-now" style:left="{snapshot.nowPct}%"></div>
                </div>
              </div>
            {/if}
          </div>

          <div class="tl-axis" aria-hidden="true">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>24</span>
          </div>
        </div>
      </section>

      <!-- Quiet Weekly Consistency Row -->
      <section class="card week-card">
        <div class="week-head">
          <span class="section-label">This Week</span>
          <span class="week-summary">{weekly.completedDays}/5 complete · {doneCount}/{totalCount} today</span>
        </div>

        <div class="week-row">
          {#each weekly.days as day (day.date)}
            <div
              class="week-cell"
              class:today={day.isToday}
              class:future={day.isFuture}
              title="{day.label} ({day.date}): {day.done}/{day.total}"
            >
              <span class="day-dot" class:full={day.status === 'full'} class:partial={day.status === 'partial'}></span>
              <span class="day-lbl">{day.label}</span>
            </div>
          {/each}
        </div>
      </section>

      <!-- Daily Trading Rituals -->
      <section class="rituals-section">
        <div class="rituals-head">
          <div class="rituals-title-wrap">
            <span class="section-label">Daily Rituals</span>
            <span class="progress-text">{progressPct}%</span>
          </div>
          <button
            class="quiet-btn"
            type="button"
            disabled={doneCount === 0}
            onclick={resetToday}
          >
            Reset
          </button>
        </div>

        <div class="progress-rail">
          <div class="progress-fill" style:width="{progressPct}%"></div>
        </div>

        {#each RITUAL_GROUPS as grp (grp.id)}
          {@const groupItems = routinesState.items.filter((i) => i.group === grp.id)}
          {@const groupDone = groupItems.filter((i) => i.done).length}
          <div class="ritual-group">
            <div class="group-head">
              <span class="group-title">
                {grp.title}
                <span class="group-count">{groupDone}/{groupItems.length}</span>
              </span>
              <button
                class="add-icon-btn"
                type="button"
                title="Add ritual to {grp.title}"
                aria-label="Add ritual to {grp.title}"
                onclick={() => openAddFor(grp.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3.5v9M3.5 8h9" />
                </svg>
              </button>
            </div>

            {#if addingGroup === grp.id}
              <div class="add-row">
                <input
                  class="add-input"
                  type="text"
                  placeholder="Add {grp.title.toLowerCase()} ritual..."
                  bind:value={newRitualLabel}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') submitNewRitual(grp.id);
                    if (e.key === 'Escape') {
                      addingGroup = null;
                      newRitualLabel = '';
                    }
                  }}
                />
                <button
                  class="add-save"
                  type="button"
                  disabled={!newRitualLabel.trim()}
                  onclick={() => submitNewRitual(grp.id)}
                >
                  Add
                </button>
              </div>
            {/if}

            <div class="ritual-list">
              {#if groupItems.length === 0}
                <div class="group-empty">No rituals in {grp.title}</div>
              {:else}
                {#each groupItems as item (item.id)}
                  <div class="ritual-row" class:done={item.done}>
                    <button
                      class="ritual-check-btn"
                      type="button"
                      role="checkbox"
                      aria-checked={item.done}
                      onclick={() => toggleRitual(item.id)}
                    >
                      <span class="check-box" class:checked={item.done}>
                        {#if item.done}
                          <svg viewBox="0 0 12 12" aria-hidden="true">
                            <path d="M2.5 6.2 5 8.7 9.5 3.5" />
                          </svg>
                        {/if}
                      </span>
                      <span class="ritual-label">{item.label}</span>
                    </button>

                    <button
                      class="ritual-del"
                      type="button"
                      title="Delete ritual"
                      aria-label="Delete ritual"
                      onclick={() => removeRitual(item.id)}
                    >
                      <svg viewBox="0 0 14 14" aria-hidden="true">
                        <path d="m3.5 3.5 7 7m0-7-7 7" />
                      </svg>
                    </button>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </section>
    </div>
  </div>
</PanelShell>

<style>
  .routines-panel {
    --rt-bg: var(--dark-bg-panel);
    --rt-surface: var(--dark-bg-surface);
    --rt-surface-alt: var(--dark-bg-surface-alt);
    --rt-border: var(--dark-border);
    --rt-border-soft: var(--dark-border-subtle);
    --rt-text: var(--dark-text-primary);
    --rt-secondary: var(--dark-text-secondary);
    --rt-hover: var(--dark-hover);
    --rt-check-bg: var(--dark-cta-bg);
    --rt-check-fg: var(--dark-cta-fg);
    --rt-check-border: var(--dark-border-check);
    --rt-track: var(--dark-track);
    --rt-now: var(--dark-text-strong);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--rt-text);
    background: var(--rt-bg);
  }

  .routines-panel.light {
    --rt-bg: #ffffff;
    --rt-surface: #f7f8fa;
    --rt-surface-alt: #f0f2f6;
    --rt-border: #e0e3eb;
    --rt-border-soft: #eef0f4;
    --rt-text: #131722;
    --rt-secondary: #6a6d78;
    --rt-hover: rgba(0, 0, 0, 0.035);
    --rt-check-bg: #131722;
    --rt-check-fg: #ffffff;
    --rt-check-border: #9da2b0;
    --rt-track: rgba(19, 23, 34, 0.08);
    --rt-now: #131722;
  }

  .rt-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .rt-scroll::-webkit-scrollbar {
    display: none;
  }

  .card {
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--rt-border-soft);
    background: var(--rt-surface);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .clock-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .clock-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .clock-time {
    font-size: 22px;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .clock-sub {
    font-size: 11.5px;
    color: var(--rt-secondary);
  }

  .clock-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
  }

  .sess-badge {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
  }

  .sess-badge.active {
    background: rgba(8, 153, 129, 0.16);
    color: #089981;
  }

  .sess-badge.overlap {
    background: rgba(245, 158, 11, 0.16);
    color: #f59e0b;
  }

  .sess-badge.closed,
  .sess-badge.quiet {
    background: var(--rt-surface-alt);
    color: var(--rt-secondary);
  }

  .countdown-row {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--rt-secondary);
    font-variant-numeric: tabular-nums;
  }

  .countdown-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--rt-secondary);
    opacity: 0.45;
    flex: 0 0 6px;
  }

  .countdown-dot.live {
    background: #089981;
    opacity: 1;
  }

  .timeline-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 2px;
  }

  .timeline-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tl-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tl-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11.5px;
  }

  .tl-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--rt-secondary);
    font-weight: 500;
  }

  .tl-name.live {
    color: var(--rt-text);
    font-weight: 600;
  }

  .tl-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 6px;
  }

  .overlap-dot {
    background: #f59e0b;
  }

  .tl-hours {
    font-size: 11px;
    color: var(--rt-secondary);
    font-variant-numeric: tabular-nums;
  }

  .tl-track {
    position: relative;
    height: 6px;
    border-radius: 999px;
    background: var(--rt-track);
    overflow: hidden;
  }

  .tl-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 999px;
    background: var(--bar-color);
    opacity: 0.34;
    transition: opacity 150ms ease;
  }

  .tl-bar.live {
    opacity: 0.92;
  }

  .tl-now {
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 2px;
    background: var(--rt-now);
    border-radius: 1px;
    transform: translateX(-1px);
    z-index: 2;
  }

  .tl-axis {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--rt-secondary);
    opacity: 0.72;
    font-variant-numeric: tabular-nums;
  }

  /* Weekly consistency row */
  .week-head {
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
    color: var(--rt-secondary);
  }

  .week-summary {
    font-size: 11.5px;
    color: var(--rt-secondary);
    font-variant-numeric: tabular-nums;
  }

  .week-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
  }

  .week-cell {
    padding: 7px 4px;
    border-radius: 8px;
    background: var(--rt-surface-alt);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
  }

  .week-cell.today {
    box-shadow: inset 0 0 0 1px var(--rt-border);
  }

  .week-cell.future {
    opacity: 0.45;
  }

  .day-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--rt-check-border);
    background: transparent;
  }

  .day-dot.partial {
    border-color: #2962ff;
    background: linear-gradient(135deg, #2962ff 50%, transparent 50%);
  }

  .day-dot.full {
    border-color: #089981;
    background: #089981;
  }

  .day-lbl {
    font-size: 11px;
    font-weight: 500;
    color: var(--rt-secondary);
  }

  .week-cell.today .day-lbl {
    color: var(--rt-text);
    font-weight: 600;
  }

  /* Daily Rituals */
  .rituals-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .rituals-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2px;
  }

  .rituals-title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .progress-text {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--rt-text);
    font-variant-numeric: tabular-nums;
  }

  .quiet-btn {
    border: 0;
    padding: 3px 8px;
    border-radius: 6px;
    background: transparent;
    color: var(--rt-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .quiet-btn:hover:not(:disabled) {
    color: var(--rt-text);
    background: var(--rt-hover);
  }

  .quiet-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .progress-rail {
    height: 3px;
    border-radius: 999px;
    background: var(--rt-track);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 999px;
    background: #089981;
    transition: width 180ms ease;
  }

  .ritual-group {
    border-radius: 10px;
    border: 1px solid var(--rt-border-soft);
    background: var(--rt-surface);
    padding: 10px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 2px;
  }

  .group-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--rt-text);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .group-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--rt-secondary);
    font-variant-numeric: tabular-nums;
  }

  .add-icon-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--rt-secondary);
    background: transparent;
    cursor: pointer;
  }

  .add-icon-btn:hover {
    color: var(--rt-text);
    background: var(--rt-hover);
  }

  .add-icon-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .add-row {
    display: flex;
    gap: 6px;
    padding: 2px 0 4px;
  }

  .add-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--rt-border);
    background: var(--rt-bg);
    color: var(--rt-text);
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .add-save {
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: var(--rt-check-bg);
    color: var(--rt-check-fg);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .add-save:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ritual-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .group-empty {
    padding: 6px 4px;
    font-size: 12px;
    color: var(--rt-secondary);
  }

  .ritual-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 5px 4px;
    border-radius: 7px;
    transition: background-color 120ms ease;
  }

  .ritual-row:hover {
    background: var(--rt-hover);
  }

  .ritual-check-btn {
    flex: 1;
    min-width: 0;
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    display: flex;
    align-items: flex-start;
    gap: 9px;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .check-box {
    width: 15px;
    height: 15px;
    margin-top: 2px;
    flex: 0 0 15px;
    border-radius: 4px;
    border: 1.5px solid var(--rt-check-border);
    background: transparent;
    display: grid;
    place-items: center;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .check-box.checked {
    border-color: var(--rt-check-bg);
    background: var(--rt-check-bg);
    color: var(--rt-check-fg);
  }

  .check-box svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ritual-label {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--rt-text);
  }

  .ritual-row.done .ritual-label {
    color: var(--rt-secondary);
    text-decoration: line-through;
  }

  .ritual-del {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    display: grid;
    place-items: center;
    color: var(--rt-secondary);
    background: transparent;
    opacity: 0;
    cursor: pointer;
    flex: 0 0 22px;
    transition: opacity 120ms ease, color 120ms ease, background-color 120ms ease;
  }

  .ritual-row:hover .ritual-del,
  .ritual-del:focus-visible {
    opacity: 1;
  }

  .ritual-del:hover {
    color: #f23645;
    background: var(--rt-hover);
  }

  .ritual-del svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }
</style>
