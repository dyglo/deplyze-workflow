<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import { subscribeAlerts, toggleNewsAlertForEvent } from '../alerts/store';
  import { FLAG_SVGS } from '../calendar/flags';
  import {
    addDays,
    buildWeekDays,
    fetchCalendarWeek,
    formatWeekRange,
    getLocalTimeZone,
    getTodayIso,
    getWeekStart,
    type CalendarCategory,
    type DayCounts,
    type EconomicEvent,
    type EventImpact
  } from '../calendar/api';

  interface Props {
    theme: 'dark' | 'light';
    onClose: () => void;
  }

  let { theme, onClose }: Props = $props();

  const CATEGORIES: { id: CalendarCategory; label: string }[] = [
    { id: 'economic', label: 'Economic' },
    { id: 'earnings', label: 'Earnings' },
    { id: 'dividends', label: 'Dividends' },
    { id: 'ipo', label: 'IPO' }
  ];

  const timeZone = getLocalTimeZone();
  const initialToday = getTodayIso(timeZone);

  let weekStart = $state(getWeekStart(initialToday));
  let selectedDate = $state(initialToday);
  let activeCategory = $state<CalendarCategory>('economic');
  let stripCollapsed = $state(false);
  let canScrollNext = $state(true);

  let countsByDate = $state<Record<string, DayCounts>>({});
  let eventsByDate = $state<Record<string, EconomicEvent[]>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let refreshNonce = $state(0);
  let armedEventIds = $state<Record<string, boolean>>({});

  onMount(() => {
    return subscribeAlerts((s) => {
      const next: Record<string, boolean> = {};
      for (const a of s.alerts) {
        if (a.kind === 'news' && a.status === 'active' && a.eventId) {
          next[a.eventId] = true;
        }
      }
      armedEventIds = next;
    });
  });

  function isUpcomingEvent(ts: number): boolean {
    return ts > Math.floor(Date.now() / 1000) + 60;
  }

  let dateInput: HTMLInputElement | undefined = $state();
  let stripEl: HTMLDivElement | undefined = $state();

  const weekDays = $derived(buildWeekDays(weekStart, countsByDate));
  const weekRangeLabel = $derived(formatWeekRange(weekStart));
  const selectedDay = $derived(weekDays.find((d) => d.iso === selectedDate) ?? weekDays[0]);
  const events = $derived(
    activeCategory === 'economic' ? (eventsByDate[selectedDay.iso] ?? []) : []
  );

  function jumpToToday() {
    const today = getTodayIso(timeZone);
    weekStart = getWeekStart(today);
    selectedDate = today;
    refreshNonce += 1;
    stripEl?.scrollTo({ left: 0, behavior: 'smooth' });
  }

  function shiftWeek(days: number) {
    weekStart = addDays(weekStart, days);
    selectedDate = addDays(selectedDate, days);
    stripEl?.scrollTo({ left: 0, behavior: 'smooth' });
  }

  function openDatePicker() {
    if (!dateInput) return;
    if (typeof dateInput.showPicker === 'function') {
      dateInput.showPicker();
    } else {
      dateInput.click();
    }
  }

  function onDatePicked(e: Event) {
    const val = (e.currentTarget as HTMLInputElement).value;
    if (!val) return;
    selectedDate = val;
    weekStart = getWeekStart(val);
    stripEl?.scrollTo({ left: 0, behavior: 'smooth' });
  }

  function scrollStripNext() {
    stripEl?.scrollBy({ left: 216, behavior: 'smooth' });
  }

  function updateStripScrollState() {
    if (!stripEl) return;
    canScrollNext = stripEl.scrollLeft + stripEl.clientWidth < stripEl.scrollWidth - 4;
  }

  function impactLevel(impact: EventImpact): number {
    if (impact === 'high') return 3;
    if (impact === 'medium') return 2;
    return 1;
  }

  $effect(() => {
    const currentWeekStart = weekStart;
    const force = refreshNonce > 0;
    const controller = new AbortController();

    loading = true;
    loadError = null;

    fetchCalendarWeek(currentWeekStart, timeZone, { force, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        const nextCounts: Record<string, DayCounts> = {};
        for (const d of res.days) {
          nextCounts[d.iso] = d.counts;
        }
        countsByDate = nextCounts;
        eventsByDate = res.eventsByDate ?? {};
        loading = false;
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        loadError = err instanceof Error ? err.message : 'Unable to load economic calendar';
        countsByDate = {};
        eventsByDate = {};
        loading = false;
      });

    return () => {
      controller.abort();
    };
  });

  $effect(() => {
    // Periodic 15-minute refresh while panel stays open so newly released actuals appear
    const timer = window.setInterval(() => {
      refreshNonce += 1;
    }, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    // Re-evaluate scroll button visibility when strip mounts, expands, or week changes
    void weekStart;
    if (!stripCollapsed && stripEl) {
      updateStripScrollState();
    }
  });
</script>

<PanelShell {theme} title="Calendar" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.75" y="3.5" width="14.5" height="13" rx="2.5" />
      <path d="M6.5 10h6.25m-2.25-2.5L13 10l-2.5 2.5" />
    </svg>
  {/snippet}

  <div class="calendar" class:light={theme === 'light'}>
    <!-- 2. Toolbar row -->
    <div class="toolbar">
      <button class="today-button" type="button" onclick={jumpToToday}>Today</button>

      <div class="date-picker-wrap">
        <button
          class="square-button"
          type="button"
          aria-label="Pick date"
          title="Pick date"
          onclick={openDatePicker}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="3" y="4" width="14" height="13" rx="2.5" />
            <path d="M6.5 2.5v3M13.5 2.5v3M3 8h14" />
          </svg>
        </button>
        <input
          bind:this={dateInput}
          class="native-date-input"
          type="date"
          value={selectedDate}
          tabindex="-1"
          aria-hidden="true"
          onchange={onDatePicked}
        />
      </div>

      <div class="nav-chevrons">
        <button
          class="chevron-button"
          type="button"
          aria-label="Previous week"
          title="Previous week"
          onclick={() => shiftWeek(-7)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m12.25 5.25-4.75 4.75 4.75 4.75" />
          </svg>
        </button>
        <button
          class="chevron-button"
          type="button"
          aria-label="Next week"
          title="Next week"
          onclick={() => shiftWeek(7)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m7.75 5.25 4.75 4.75-4.75 4.75" />
          </svg>
        </button>
      </div>

      <span class="range-label">{weekRangeLabel}</span>

      <div class="toolbar-right">
        <button
          class="square-button"
          type="button"
          aria-label="Calendar settings"
          title="Calendar settings"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7.2 4h5.6a1.5 1.5 0 0 1 1.3.75l2.8 4.5a1.5 1.5 0 0 1 0 1.5l-2.8 4.5a1.5 1.5 0 0 1-1.3.75H7.2a1.5 1.5 0 0 1-1.3-.75l-2.8-4.5a1.5 1.5 0 0 1 0-1.5l2.8-4.5A1.5 1.5 0 0 1 7.2 4Z" />
            <circle cx="10" cy="10" r="2.6" />
          </svg>
        </button>

        <button
          class="square-button"
          class:collapsed={stripCollapsed}
          type="button"
          aria-label={stripCollapsed ? 'Expand day strip' : 'Collapse day strip'}
          title={stripCollapsed ? 'Expand day strip' : 'Collapse day strip'}
          aria-expanded={!stripCollapsed}
          onclick={() => (stripCollapsed = !stripCollapsed)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5.5 12 4.5-4.5 4.5 4.5" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 3. Day strip -->
    {#if !stripCollapsed}
      <div class="day-strip-wrap">
        <div
          bind:this={stripEl}
          class="day-strip"
          onscroll={updateStripScrollState}
        >
          {#each weekDays as day (day.iso)}
            <button
              class="day-card"
              class:selected={day.iso === selectedDay.iso}
              type="button"
              aria-pressed={day.iso === selectedDay.iso}
              onclick={() => (selectedDate = day.iso)}
            >
              <span class="day-label">{day.shortLabel}</span>
              <div class="day-counts">
                <div class="count-row">
                  <span class="count-label">Economic</span>
                  <span class="count-value">{day.counts.economic}</span>
                </div>
                <div class="count-row">
                  <span class="count-label">Earnings</span>
                  <span class="count-value">{day.counts.earnings}</span>
                </div>
                <div class="count-row">
                  <span class="count-label">Dividends</span>
                  <span class="count-value">{day.counts.dividends}</span>
                </div>
                {#if day.counts.ipo > 0}
                  <div class="count-row">
                    <span class="count-label">IPO</span>
                    <span class="count-value">{day.counts.ipo}</span>
                  </div>
                {/if}
              </div>
            </button>
          {/each}
        </div>

        {#if canScrollNext}
          <button
            class="strip-next-button"
            type="button"
            aria-label="Scroll days right"
            onclick={scrollStripNext}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m8 5.25 4.75 4.75L8 14.75" />
            </svg>
          </button>
        {/if}
      </div>
    {/if}

    <!-- 4. Category pills -->
    <div class="category-pills" role="tablist" aria-label="Calendar categories">
      {#each CATEGORIES as cat (cat.id)}
        <button
          class="pill"
          class:active={activeCategory === cat.id}
          type="button"
          role="tab"
          aria-selected={activeCategory === cat.id}
          onclick={() => (activeCategory = cat.id)}
        >
          {cat.label}
        </button>
      {/each}
    </div>

    <!-- 5. Filter row -->
    <div class="filter-row">
      <button
        class="filter-icon-button"
        type="button"
        aria-label="Importance filter"
        title="Importance filter"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3.5" y="11" width="3" height="5.5" rx="0.5" />
          <rect x="8.5" y="7.5" width="3" height="9" rx="0.5" />
          <rect x="13.5" y="4" width="3" height="12.5" rx="0.5" />
        </svg>
      </button>

      <span class="filter-divider" aria-hidden="true"></span>

      <button class="filter-dropdown" type="button" aria-haspopup="listbox">
        <svg class="list-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" />
          <path d="M7.25 5.5h9.25M7.25 10h9.25M7.25 14.5h9.25" />
        </svg>
        <span>All categories</span>
        <svg class="dropdown-chevron" viewBox="0 0 20 20" aria-hidden="true">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
    </div>

    <!-- 6. Day heading -->
    <div class="day-heading">
      {selectedDay.fullHeading}
    </div>

    <!-- 7. Event list -->
    <div class="event-list">
      {#if activeCategory !== 'economic'}
        <div class="empty-state">No data yet</div>
      {:else if loading}
        <div class="empty-state">Loading events...</div>
      {:else if loadError}
        <div class="empty-state">Unable to load calendar data</div>
      {:else if events.length === 0}
        <div class="empty-state">No events scheduled</div>
      {:else}
        {#each events as event (event.id)}
          {@const level = impactLevel(event.impact)}
          <div class="event-row">
            <div class="event-left">
              <span class="time-badge" class:flagged={Boolean(event.flagged)}>
                {event.time}
              </span>

              <div class="event-indicators">
                <svg
                  class="flag-icon"
                  viewBox="0 0 16 16"
                  aria-label={event.country}
                  role="img"
                >
                  {@html FLAG_SVGS[event.country] ?? FLAG_SVGS.US}
                  <circle
                    cx="8"
                    cy="8"
                    r="7.6"
                    fill="none"
                    stroke="var(--cal-flag-ring)"
                    stroke-width="0.8"
                  />
                </svg>

                <svg
                  class="impact-bars"
                  viewBox="0 0 14 12"
                  aria-label="{event.impact} impact"
                  role="img"
                >
                  <rect
                    x="1"
                    y="7"
                    width="2.5"
                    height="5"
                    rx="0.9"
                    class:filled={level >= 1}
                  />
                  <rect
                    x="5.5"
                    y="4"
                    width="2.5"
                    height="8"
                    rx="0.9"
                    class:filled={level >= 2}
                  />
                  <rect
                    x="10"
                    y="1"
                    width="2.5"
                    height="11"
                    rx="0.9"
                    class:filled={level >= 3}
                  />
                </svg>
              </div>
            </div>

            <div class="event-main">
              <div class="event-title-row">
                <div class="event-title">{event.title}</div>
                {#if isUpcomingEvent(event.ts)}
                  {@const isArmed = Boolean(armedEventIds[event.id])}
                  <button
                    class="news-bell"
                    class:armed={isArmed}
                    type="button"
                    title={isArmed
                      ? '15-min pre-news alert active (click to remove)'
                      : 'Notify me 15 min before release'}
                    aria-label={isArmed ? 'Remove news alert' : 'Set 15-minute news alert'}
                    onclick={() =>
                      toggleNewsAlertForEvent({
                        eventId: event.id,
                        title: event.title,
                        country: event.country,
                        ts: event.ts,
                        leadMinutes: 15
                      })
                    }
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2.25a3.75 3.75 0 0 0-3.75 3.75v2.2c0 .6-.22 1.18-.62 1.63l-.63.72h10l-.63-.72a2.45 2.45 0 0 1-.62-1.63V6A3.75 3.75 0 0 0 8 2.25Z" />
                      <path d="M6.4 12.25a1.65 1.65 0 0 0 3.2 0" />
                    </svg>
                  </button>
                {/if}
              </div>
              {#if event.actual || event.prior || event.forecast}
                <div class="event-meta">
                  {#if event.actual}
                    <span class="meta-pair">
                      <span class="meta-label">Actual:</span>
                      <span class="meta-value">{event.actual}</span>
                    </span>
                  {/if}
                  {#if event.prior}
                    <span class="meta-pair">
                      <span class="meta-label">Prior:</span>
                      <span class="meta-value">{event.prior}</span>
                    </span>
                  {/if}
                  {#if event.forecast}
                    <span class="meta-pair">
                      <span class="meta-label">Forecast:</span>
                      <span class="meta-value">{event.forecast}</span>
                    </span>
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
  .calendar {
    --cal-bg: #000000;
    --cal-border: #2a2e39;
    --cal-card-border: #2a2e39;
    --cal-row-divider: #2a2e39;
    --cal-text: #d1d4dc;
    --cal-secondary: #787b86;
    --cal-selected-card: #1e222d;
    --cal-underline: #d1d4dc;
    --cal-pill-bg: #1e222d;
    --cal-pill-text: #d1d4dc;
    --cal-pill-active-bg: #d1d4dc;
    --cal-pill-active-text: #000000;
    --cal-heading-bg: #0d1017;
    --cal-heading-accent: #d1d4dc;
    --cal-row-hover: rgba(255, 255, 255, 0.04);
    --cal-control-hover: rgba(255, 255, 255, 0.06);
    --cal-scroll-bg: #1e222d;
    --cal-scroll-border: #2a2e39;
    --cal-scroll-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
    --cal-bar-empty: #363a45;
    --cal-flag-ring: rgba(255, 255, 255, 0.14);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--cal-text);
    background: var(--cal-bg);
    transition: color 150ms ease, background-color 150ms ease;
  }

  .calendar.light {
    --cal-bg: #ffffff;
    --cal-border: #e0e3eb;
    --cal-card-border: #eceef2;
    --cal-row-divider: #f0f2f5;
    --cal-text: #131722;
    --cal-secondary: #6a6d78;
    --cal-selected-card: #f2f2f2;
    --cal-underline: #131722;
    --cal-pill-bg: #f2f2f2;
    --cal-pill-text: #131722;
    --cal-pill-active-bg: #222222;
    --cal-pill-active-text: #ffffff;
    --cal-heading-bg: #f9f9f9;
    --cal-heading-accent: #000000;
    --cal-row-hover: rgba(0, 0, 0, 0.03);
    --cal-control-hover: rgba(0, 0, 0, 0.04);
    --cal-scroll-bg: #ffffff;
    --cal-scroll-border: transparent;
    --cal-scroll-shadow: 0 2px 8px rgba(0, 0, 0, 0.16);
    --cal-bar-empty: #d1d4dc;
    --cal-flag-ring: rgba(0, 0, 0, 0.08);
  }

  /* 2. Toolbar row */
  .toolbar {
    height: 36px;
    flex: 0 0 36px;
    padding: 0 16px;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }

  .today-button {
    height: 36px;
    min-width: 66px;
    padding: 0 12px;
    flex: 0 0 auto;
    border: 1px solid var(--cal-border);
    border-radius: 8px;
    color: var(--cal-text);
    background: transparent;
    font: inherit;
    font-size: 14px;
    font-weight: 400;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .today-button:hover,
  .square-button:hover,
  .chevron-button:hover,
  .filter-icon-button:hover,
  .filter-dropdown:hover {
    background: var(--cal-control-hover);
  }

  .date-picker-wrap {
    position: relative;
    flex: 0 0 36px;
  }

  .native-date-input {
    position: absolute;
    inset: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .square-button {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--cal-border);
    border-radius: 8px;
    color: var(--cal-text);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .square-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .square-button.collapsed svg {
    transform: rotate(180deg);
  }

  .nav-chevrons {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }

  .chevron-button {
    width: 24px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--cal-text);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .chevron-button svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .range-label {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.015em;
    color: var(--cal-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .toolbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  /* 3. Day strip */
  .day-strip-wrap {
    position: relative;
    flex: 0 0 auto;
    user-select: none;
  }

  .day-strip {
    display: flex;
    gap: 8px;
    padding: 0 16px;
    overflow-x: auto;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .day-strip::-webkit-scrollbar {
    display: none;
  }

  .day-card {
    width: 100px;
    flex: 0 0 100px;
    min-height: 132px;
    padding: 12px;
    border: 1px solid var(--cal-card-border);
    border-radius: 12px;
    color: var(--cal-text);
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .day-card:hover:not(.selected) {
    background: var(--cal-row-hover);
  }

  .day-card.selected {
    background: var(--cal-selected-card);
    border-color: transparent;
  }

  .day-label {
    align-self: flex-start;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.2;
    color: var(--cal-text);
    padding-bottom: 4px;
    margin-bottom: 8px;
    border-bottom: 2px solid transparent;
    transition: border-color 150ms ease, color 150ms ease;
  }

  .day-card.selected .day-label {
    border-bottom-color: var(--cal-underline);
  }

  .day-counts {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .count-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 4px;
    font-size: 12px;
    line-height: 1.45;
  }

  .count-label {
    color: var(--cal-secondary);
  }

  .count-value {
    color: var(--cal-text);
    font-variant-numeric: tabular-nums;
  }

  .strip-next-button {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid var(--cal-scroll-border);
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--cal-text);
    background: var(--cal-scroll-bg);
    box-shadow: var(--cal-scroll-shadow);
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .strip-next-button svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* 4. Category pills */
  .category-pills {
    flex: 0 0 auto;
    padding: 16px 16px 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    user-select: none;
  }

  .category-pills::-webkit-scrollbar {
    display: none;
  }

  .pill {
    height: 34px;
    padding: 0 14px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 17px;
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    color: var(--cal-pill-text);
    background: var(--cal-pill-bg);
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .pill.active {
    color: var(--cal-pill-active-text);
    background: var(--cal-pill-active-bg);
  }

  /* 5. Filter row */
  .filter-row {
    height: 44px;
    flex: 0 0 44px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    user-select: none;
  }

  .filter-icon-button {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--cal-text);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .filter-icon-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .filter-divider {
    width: 1px;
    height: 20px;
    background: var(--cal-border);
  }

  .filter-dropdown {
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--cal-text);
    background: transparent;
    font: inherit;
    font-size: 14px;
    font-weight: 400;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .filter-dropdown .list-icon {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .filter-dropdown .dropdown-chevron {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* 6. Day heading */
  .day-heading {
    height: 40px;
    flex: 0 0 40px;
    margin-left: 16px;
    padding: 0 16px 0 12px;
    display: flex;
    align-items: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--cal-text);
    background: var(--cal-heading-bg);
    border-left: 3px solid var(--cal-heading-accent);
    border-bottom: 1px solid var(--cal-border);
    transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
  }

  /* 7. Event list */
  .event-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .event-list::-webkit-scrollbar {
    display: none;
  }

  .empty-state {
    padding: 56px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--cal-secondary);
  }

  .event-row {
    min-height: 62px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--cal-row-divider);
    display: flex;
    align-items: flex-start;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .event-row:hover {
    background: var(--cal-row-hover);
  }

  .event-left {
    width: 64px;
    flex: 0 0 64px;
    margin-right: 30px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .time-badge {
    display: inline-block;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.1;
    padding: 3px 6px;
    font-variant-numeric: tabular-nums;
    color: var(--cal-text);
  }

  .time-badge.flagged {
    padding: 4px 8px;
    border-radius: 6px;
    color: #ffffff;
    background: #f23645;
  }

  .event-indicators {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 6px;
  }

  .flag-icon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    display: block;
    border-radius: 50%;
    overflow: hidden;
  }

  .impact-bars {
    width: 14px;
    height: 12px;
    flex: 0 0 14px;
    display: block;
  }

  .impact-bars rect {
    fill: var(--cal-bar-empty);
    transition: fill 150ms ease;
  }

  .impact-bars rect.filled {
    fill: #2962ff;
  }

  .event-main {
    flex: 1;
    min-width: 0;
    padding-top: 2px;
    display: flex;
    flex-direction: column;
  }

  .event-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
  }

  .event-title {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--cal-text);
  }

  .news-bell {
    width: 22px;
    height: 22px;
    margin-top: -2px;
    flex: 0 0 22px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    display: grid;
    place-items: center;
    color: var(--cal-secondary);
    background: transparent;
    opacity: 0;
    cursor: pointer;
    transition: opacity 130ms ease, color 130ms ease, background-color 130ms ease;
  }

  .event-row:hover .news-bell,
  .news-bell.armed {
    opacity: 1;
  }

  .news-bell:hover {
    color: var(--cal-text);
    background: var(--cal-control-hover);
  }

  .news-bell.armed {
    color: #2962ff;
  }

  .news-bell svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .news-bell.armed svg path:first-child {
    fill: currentColor;
  }

  .event-meta {
    margin-top: 8px;
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 12px;
  }

  .meta-pair {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }

  .meta-label {
    font-size: 11px;
    color: var(--cal-secondary);
  }

  .meta-value {
    font-size: 12px;
    font-weight: 500;
    color: var(--cal-text);
    font-variant-numeric: tabular-nums;
  }

  button:focus-visible {
    outline: 1px solid var(--cal-text);
    outline-offset: -2px;
  }
</style>
