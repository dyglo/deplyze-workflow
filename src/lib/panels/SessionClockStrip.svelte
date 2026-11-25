<script lang="ts">
  import { onMount } from 'svelte';
  import { computeSessionsSnapshot } from '../routines/store';

  interface Props {
    theme: 'dark' | 'light';
  }

  let { theme }: Props = $props();

  let nowTick = $state(new Date());
  let collapsed = $state(false);

  const snapshot = $derived(computeSessionsSnapshot(nowTick));

  onMount(() => {
    const timer = setInterval(() => {
      nowTick = new Date();
    }, 30_000);
    return () => clearInterval(timer);
  });

  function shortTzName(tz: string): string {
    const parts = tz.split('/');
    return (parts[parts.length - 1] ?? tz).replace(/_/g, ' ');
  }
</script>

<section class="session-strip" class:light={theme === 'light'} aria-label="Market session clock">
  <div class="ss-top">
    <div class="ss-time-wrap">
      <span class="ss-time">{snapshot.localTimeLabel}</span>
      <span class="ss-tz">{shortTzName(snapshot.timeZone)}</span>
    </div>

    <div class="ss-right">
      {#if snapshot.isWeekendClosed}
        <span class="ss-badge closed">Weekend</span>
      {:else if snapshot.overlapActive}
        <span class="ss-badge overlap">LDN–NY</span>
      {:else if snapshot.activeNames.length > 0}
        {#each snapshot.activeNames as name (name)}
          <span class="ss-badge active">{name}</span>
        {/each}
      {:else}
        <span class="ss-badge quiet">Off-Session</span>
      {/if}

      <button
        class="ss-toggle"
        type="button"
        title={collapsed ? 'Expand session bars' : 'Collapse session bars'}
        aria-label={collapsed ? 'Expand session bars' : 'Collapse session bars'}
        onclick={() => (collapsed = !collapsed)}
      >
        <svg class:flipped={collapsed} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
    </div>
  </div>

  <div class="ss-countdown">
    <span
      class="ss-dot"
      class:live={!snapshot.isWeekendClosed && snapshot.activeNames.length > 0}
    ></span>
    <span class="ss-next">
      {#if snapshot.isWeekendClosed}
        Markets closed · {snapshot.nextEventLabel}
      {:else}
        {snapshot.nextEventLabel}
      {/if}
    </span>
  </div>

  {#if !collapsed}
    <div class="tl-wrap" aria-label="24-hour trading sessions timeline">
      <div class="tl-rows">
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
          <div class="tl-row">
            <div class="tl-meta">
              <span class="tl-name" class:live={snapshot.overlapActive}>
                <span class="tl-dot" style:background="#f59e0b"></span>
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
  {/if}
</section>

<style>
  .session-strip {
    flex: 0 0 auto;
    padding: 8px 14px 10px;
    border-bottom: 1px solid var(--dark-border-subtle);
    background: var(--dark-bg-panel);
    color: var(--dark-text-primary);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .session-strip.light {
    background: #ffffff;
    color: #131722;
    border-bottom-color: #eceff4;
  }

  .ss-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .ss-time-wrap {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }

  .ss-time {
    font-size: 14px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  .ss-tz {
    font-size: 11px;
    color: var(--dark-text-secondary);
  }

  .session-strip.light .ss-tz {
    color: #6a7282;
  }

  .ss-right {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .ss-badge {
    height: 19px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
  }

  .ss-badge.active {
    background: rgba(8, 153, 129, 0.16);
    color: #20c9ad;
  }

  .ss-badge.overlap {
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
  }

  .ss-badge.closed,
  .ss-badge.quiet {
    background: var(--dark-bg-surface-alt);
    color: var(--dark-text-secondary);
  }

  .session-strip.light .ss-badge.active {
    color: #067a67;
  }

  .session-strip.light .ss-badge.overlap {
    color: #b45309;
  }

  .session-strip.light .ss-badge.closed,
  .session-strip.light .ss-badge.quiet {
    background: #f0f2f6;
    color: #5d6473;
  }

  .ss-toggle {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--dark-text-secondary);
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }

  .ss-toggle:hover {
    background: var(--dark-hover-strong);
    color: var(--dark-text-strong);
  }

  .session-strip.light .ss-toggle:hover {
    background: #f0f2f6;
    color: #131722;
  }

  .ss-toggle svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .ss-toggle svg.flipped {
    transform: rotate(-90deg);
  }

  .ss-countdown {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--dark-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .session-strip.light .ss-countdown {
    color: #5d6473;
  }

  .ss-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--dark-text-muted);
    flex: 0 0 6px;
  }

  .ss-dot.live {
    background: #089981;
  }

  .tl-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 2px;
  }

  .tl-rows {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .tl-row {
    display: grid;
    grid-template-columns: 112px 1fr;
    align-items: center;
    gap: 8px;
  }

  .tl-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    min-width: 0;
  }

  .tl-name {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--dark-text-secondary);
    white-space: nowrap;
  }

  .tl-name.live {
    color: var(--dark-text-strong);
    font-weight: 600;
  }

  .session-strip.light .tl-name {
    color: #5d6473;
  }

  .session-strip.light .tl-name.live {
    color: #131722;
  }

  .tl-dot {
    width: 5px;
    height: 5px;
    border-radius: 999px;
    flex: 0 0 5px;
  }

  .tl-hours {
    font-size: 9.5px;
    color: var(--dark-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .tl-track {
    position: relative;
    height: 6px;
    border-radius: 999px;
    background: var(--dark-track);
    overflow: hidden;
  }

  .session-strip.light .tl-track {
    background: rgba(19, 23, 34, 0.08);
  }

  .tl-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 999px;
    background: var(--bar-color);
    opacity: 0.36;
  }

  .tl-bar.live {
    opacity: 0.95;
  }

  .tl-now {
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 1.5px;
    background: var(--dark-text-strong);
    z-index: 2;
  }

  .session-strip.light .tl-now {
    background: #131722;
  }

  .tl-axis {
    display: flex;
    justify-content: space-between;
    padding-left: 120px;
    font-size: 9px;
    color: var(--dark-text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
