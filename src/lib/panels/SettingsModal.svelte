<script lang="ts">
  import ColorPickerPopover from './ColorPickerPopover.svelte';
  import {
    cloneChartSettings,
    toRgba,
    type ChartSettings,
    type RgbaColor
  } from '../settings/chartSettings';

  type SettingsTab =
    | 'symbol'
    | 'status'
    | 'scales'
    | 'canvas'
    | 'trading'
    | 'alerts'
    | 'events';

  type CandleColorKey =
    | 'bodyUp'
    | 'bodyDown'
    | 'borderUp'
    | 'borderDown'
    | 'wickUp'
    | 'wickDown';

  interface Props {
    theme: 'dark' | 'light';
    settings: ChartSettings;
    onSave: (next: ChartSettings) => void;
    onClose: () => void;
  }

  let { theme, settings, onSave, onClose }: Props = $props();

  const MODAL_WIDTH = 680;
  const MODAL_HEIGHT = 590;
  const TITLE_BAR_HEIGHT = 32;

  let activeTab = $state<SettingsTab>('canvas');

  // Local draft for persistent chart settings (committed on Ok, discarded on Cancel)
  // svelte-ignore state_referenced_locally
  let draft = $state<ChartSettings>(cloneChartSettings(settings));

  // Active color picker popover state
  let openPicker = $state<{ key: CandleColorKey; rect: DOMRect } | null>(null);

  // Visual-only local toggles for the Events reference tab
  let showIdeas = $state(false);
  let showSessionBreaks = $state(false);
  let showEconomicEvents = $state(true);
  let onlyFutureEvents = $state(true);
  let showEventsBreaks = $state(false);
  let showLatestNews = $state(true);
  let showNewsNotification = $state(false);

  // Floating modal drag state (centered initially)
  let posX = $state(
    typeof window !== 'undefined'
      ? Math.max(16, Math.round((window.innerWidth - MODAL_WIDTH) / 2))
      : 220
  );
  let posY = $state(
    typeof window !== 'undefined'
      ? Math.max(TITLE_BAR_HEIGHT + 12, Math.round((window.innerHeight - MODAL_HEIGHT) / 2))
      : 64
  );

  let dragging = $state(false);
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let modalEl: HTMLDivElement | undefined = $state();

  function clampPosition(x: number, y: number): { x: number; y: number } {
    if (typeof window === 'undefined') return { x, y };
    const w = modalEl?.offsetWidth ?? MODAL_WIDTH;
    const h = modalEl?.offsetHeight ?? MODAL_HEIGHT;
    const minVisible = 120;
    const minX = -w + minVisible;
    const maxX = window.innerWidth - minVisible;
    const minY = TITLE_BAR_HEIGHT + 4;
    const maxY = Math.max(minY, window.innerHeight - 64);
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, x))),
      y: Math.round(Math.min(maxY, Math.max(minY, y)))
    };
  }

  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    openPicker = null;
    dragging = true;
    dragOffsetX = e.clientX - posX;
    dragOffsetY = e.clientY - posY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const next = clampPosition(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
    posX = next.x;
    posY = next.y;
  }

  function onHeaderPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId);
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !openPicker) {
      onClose();
    }
  }

  function onWindowResize() {
    openPicker = null;
    const next = clampPosition(posX, posY);
    posX = next.x;
    posY = next.y;
  }

  function selectTab(tab: SettingsTab) {
    openPicker = null;
    activeTab = tab;
  }

  function toggleColorPicker(key: CandleColorKey, e: MouseEvent) {
    if (openPicker?.key === key) {
      openPicker = null;
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openPicker = { key, rect };
  }

  function updateCandleColor(key: CandleColorKey, next: RgbaColor) {
    draft.candles[key] = next;
  }

  function handleSave() {
    openPicker = null;
    onSave(cloneChartSettings(draft));
    onClose();
  }
</script>

<svelte:window onkeydown={onWindowKeyDown} onresize={onWindowResize} />

<div
  bind:this={modalEl}
  class="settings-modal"
  class:light={theme === 'light'}
  class:dragging
  style:left="{posX}px"
  style:top="{posY}px"
  role="dialog"
  aria-modal="false"
  aria-labelledby="settings-modal-title"
>
  <!-- Draggable Header -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    class="modal-header"
    onpointerdown={onHeaderPointerDown}
    onpointermove={onHeaderPointerMove}
    onpointerup={onHeaderPointerUp}
    onpointercancel={onHeaderPointerUp}
  >
    <h2 id="settings-modal-title" class="modal-title">Settings</h2>
    <button
      class="close-button"
      type="button"
      aria-label="Close settings"
      onclick={onClose}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5 5 10 10m0-10L5 15" />
      </svg>
    </button>
  </header>

  <!-- Body: Sidebar + Content -->
  <div class="modal-body">
    <nav class="modal-nav" aria-label="Settings sections">
      <button
        class="nav-item"
        class:active={activeTab === 'symbol'}
        type="button"
        onclick={() => selectTab('symbol')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M6.5 3.5v2.25M6.5 13.25v3.25M13.5 3.5v4M13.5 14.5v2" />
          <rect x="4.5" y="5.75" width="4" height="7.5" rx="0.8" />
          <rect x="11.5" y="7.5" width="4" height="7" rx="0.8" />
        </svg>
        <span>Symbol</span>
      </button>

      <button
        class="nav-item"
        class:active={activeTab === 'status'}
        type="button"
        onclick={() => selectTab('status')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.5 5.5h13M3.5 8.5h10M3.5 11.5h12M3.5 14.5h7.5" />
        </svg>
        <span>Status line</span>
      </button>

      <button
        class="nav-item"
        class:active={activeTab === 'scales'}
        type="button"
        onclick={() => selectTab('scales')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5.5 3.5v11h11" />
          <path d="M3.75 5.25 5.5 3.5l1.75 1.75M14.75 12.75 16.5 14.5l-1.75 1.75" />
        </svg>
        <span>Scales and lines</span>
      </button>

      <button
        class="nav-item"
        class:active={activeTab === 'canvas'}
        type="button"
        onclick={() => selectTab('canvas')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M13.6 4.4a1.75 1.75 0 0 1 2.45 2.45l-8.1 8.1-3.4.85.85-3.4 8.2-8Z" />
        </svg>
        <span>Canvas</span>
      </button>

      <button
        class="nav-item"
        class:active={activeTab === 'trading'}
        type="button"
        onclick={() => selectTab('trading')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m3.5 13.75 4.25-4.25 3 2.5 5.75-5.75" />
          <path d="M12.75 6.25h3.75V10" />
        </svg>
        <span>Trading</span>
      </button>

      <button
        class="nav-item"
        class:active={activeTab === 'alerts'}
        type="button"
        onclick={() => selectTab('alerts')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10.75" r="5.5" />
          <path d="M10 8v3l2 1.25M4.25 5.25 6.5 3.5M15.75 5.25 13.5 3.5" />
        </svg>
        <span>Alerts</span>
      </button>

      <button
        class="nav-item"
        class:active={activeTab === 'events'}
        type="button"
        onclick={() => selectTab('events')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3.25" y="4.25" width="13.5" height="12.25" rx="2.25" />
          <path d="M6.75 2.75v2.75M13.25 2.75v2.75M3.25 8h13.5" />
        </svg>
        <span>Events</span>
      </button>
    </nav>

    <div class="modal-content">
      {#if activeTab === 'canvas'}
        <section class="settings-section">
          <h3 class="section-label">Chart basic styles</h3>

          <div class="setting-row">
            <span class="row-label">Background</span>
            <div class="row-controls">
              <div class="select-box wide">
                <span>Solid</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
              <span
                class="swatch-box"
                style:--swatch={theme === 'light' ? '#ffffff' : '#000000'}
                aria-hidden="true"
              ></span>
            </div>
          </div>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={draft.verticalGrid}
                onchange={(e) => (draft.verticalGrid = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Vertical grid lines</span>
            </label>
            <div class="row-controls">
              <div class="line-swatch" class:muted={!draft.verticalGrid} aria-hidden="true">
                <span class="checker-chip" class:filled-grid={draft.verticalGrid}></span>
                <span class="dash-sample"></span>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={draft.horizontalGrid}
                onchange={(e) => (draft.horizontalGrid = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Horizontal grid lines</span>
            </label>
            <div class="row-controls">
              <div class="line-swatch" class:muted={!draft.horizontalGrid} aria-hidden="true">
                <span class="checker-chip" class:filled-grid={draft.horizontalGrid}></span>
                <span class="dash-sample"></span>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <span class="row-label">Crosshair</span>
            <div class="row-controls">
              <div class="line-swatch" aria-hidden="true">
                <span class="color-chip" style:background="#9598a1"></span>
                <span class="dash-sample"></span>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <span class="row-label">Watermark</span>
            <div class="row-controls">
              <div class="select-box xl">
                <span>Replay mode</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
              <span class="swatch-box checker" aria-hidden="true"></span>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="section-label">Scales</h3>

          <div class="setting-row">
            <span class="row-label">Text</span>
            <div class="row-controls">
              <span
                class="swatch-box"
                style:--swatch={theme === 'light' ? '#131722' : '#d1d4dc'}
                aria-hidden="true"
              ></span>
              <div class="select-box compact">
                <span>12</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <span class="row-label">Lines</span>
            <div class="row-controls">
              <span class="swatch-box checker" aria-hidden="true"></span>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="section-label">Buttons</h3>

          <div class="setting-row">
            <span class="row-label">Navigation</span>
            <div class="row-controls">
              <div class="select-box xl">
                <span>Visible on mouse over</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
            </div>
          </div>
        </section>
      {:else if activeTab === 'symbol'}
        <section class="settings-section">
          <h3 class="section-label">Candles</h3>

          <div class="setting-row single">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={draft.candles.colorBarsOnPrevClose}
                onchange={(e) =>
                  (draft.candles.colorBarsOnPrevClose = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Color bars based on previous close</span>
            </label>
          </div>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={draft.candles.drawBody}
                onchange={(e) =>
                  (draft.candles.drawBody = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Body</span>
            </label>
            <div class="row-controls">
              <button
                class="swatch-button"
                class:picker-open={openPicker?.key === 'bodyUp'}
                class:muted={!draft.candles.drawBody}
                type="button"
                data-color-swatch-trigger="true"
                aria-label="Bullish candle body color"
                style:--swatch={toRgba(draft.candles.bodyUp)}
                onclick={(e) => toggleColorPicker('bodyUp', e)}
              ></button>
              <button
                class="swatch-button"
                class:picker-open={openPicker?.key === 'bodyDown'}
                class:muted={!draft.candles.drawBody}
                type="button"
                data-color-swatch-trigger="true"
                aria-label="Bearish candle body color"
                style:--swatch={toRgba(draft.candles.bodyDown)}
                onclick={(e) => toggleColorPicker('bodyDown', e)}
              ></button>
            </div>
          </div>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={draft.candles.drawBorder}
                onchange={(e) =>
                  (draft.candles.drawBorder = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Borders</span>
            </label>
            <div class="row-controls">
              <button
                class="swatch-button"
                class:picker-open={openPicker?.key === 'borderUp'}
                class:muted={!draft.candles.drawBorder}
                type="button"
                data-color-swatch-trigger="true"
                aria-label="Bullish candle border color"
                style:--swatch={toRgba(draft.candles.borderUp)}
                onclick={(e) => toggleColorPicker('borderUp', e)}
              ></button>
              <button
                class="swatch-button"
                class:picker-open={openPicker?.key === 'borderDown'}
                class:muted={!draft.candles.drawBorder}
                type="button"
                data-color-swatch-trigger="true"
                aria-label="Bearish candle border color"
                style:--swatch={toRgba(draft.candles.borderDown)}
                onclick={(e) => toggleColorPicker('borderDown', e)}
              ></button>
            </div>
          </div>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={draft.candles.drawWick}
                onchange={(e) =>
                  (draft.candles.drawWick = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Wick</span>
            </label>
            <div class="row-controls">
              <button
                class="swatch-button"
                class:picker-open={openPicker?.key === 'wickUp'}
                class:muted={!draft.candles.drawWick}
                type="button"
                data-color-swatch-trigger="true"
                aria-label="Bullish candle wick color"
                style:--swatch={toRgba(draft.candles.wickUp)}
                onclick={(e) => toggleColorPicker('wickUp', e)}
              ></button>
              <button
                class="swatch-button"
                class:picker-open={openPicker?.key === 'wickDown'}
                class:muted={!draft.candles.drawWick}
                type="button"
                data-color-swatch-trigger="true"
                aria-label="Bearish candle wick color"
                style:--swatch={toRgba(draft.candles.wickDown)}
                onclick={(e) => toggleColorPicker('wickDown', e)}
              ></button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="section-label">Data modification</h3>

          <div class="setting-row">
            <span class="row-label">Precision</span>
            <div class="row-controls">
              <div class="select-box wide">
                <span>Default</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <span class="row-label">Timezone</span>
            <div class="row-controls">
              <div class="select-box wide">
                <span>(UTC+3) Nairobi</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
            </div>
          </div>
        </section>
      {:else if activeTab === 'events'}
        <section class="settings-section">
          <h3 class="section-label">Events</h3>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={showIdeas}
                onchange={(e) => (showIdeas = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Ideas</span>
            </label>
            <div class="row-controls">
              <div class="select-box compact" class:muted={!showIdeas}>
                <span>All ideas</span>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
                </svg>
              </div>
              <span class="help-badge" aria-hidden="true">?</span>
            </div>
          </div>

          <div class="setting-row">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={showSessionBreaks}
                onchange={(e) => (showSessionBreaks = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Session breaks</span>
            </label>
            <div class="row-controls">
              <div class="line-swatch" class:muted={!showSessionBreaks} aria-hidden="true">
                <span class="color-chip" style:background="#789cf0"></span>
                <span class="dash-sample"></span>
              </div>
            </div>
          </div>

          <div class="setting-row single">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={showEconomicEvents}
                onchange={(e) => (showEconomicEvents = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Economic events</span>
            </label>
          </div>

          <div class="setting-row single indented">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={onlyFutureEvents}
                onchange={(e) => (onlyFutureEvents = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Only future events</span>
            </label>
          </div>

          <div class="setting-row indented">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={showEventsBreaks}
                onchange={(e) => (showEventsBreaks = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Events breaks</span>
            </label>
            <div class="row-controls">
              <div class="line-swatch" class:muted={!showEventsBreaks} aria-hidden="true">
                <span class="color-chip" style:background="#9598a1"></span>
                <span class="dash-sample"></span>
              </div>
            </div>
          </div>

          <div class="setting-row single">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={showLatestNews}
                onchange={(e) => (showLatestNews = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>Latest news</span>
            </label>
          </div>

          <div class="setting-row single">
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={showNewsNotification}
                onchange={(e) => (showNewsNotification = (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="checkbox-box" aria-hidden="true">
                <svg viewBox="0 0 14 14"><path d="m3 7.2 2.6 2.6L11 4.2" /></svg>
              </span>
              <span>News notification</span>
            </label>
          </div>
        </section>
      {:else}
        <div class="placeholder-tab">No configurable options yet</div>
      {/if}
    </div>
  </div>

  <!-- Footer -->
  <footer class="modal-footer">
    <button class="template-button" type="button">
      <span>Template</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
      </svg>
    </button>

    <div class="footer-actions">
      <button class="cancel-button" type="button" onclick={onClose}>Cancel</button>
      <button class="ok-button" type="button" onclick={handleSave}>Ok</button>
    </div>
  </footer>
</div>

{#if openPicker}
  <ColorPickerPopover
    {theme}
    value={draft.candles[openPicker.key]}
    anchorRect={openPicker.rect}
    onChange={(next) => openPicker && updateCandleColor(openPicker.key, next)}
    onClose={() => (openPicker = null)}
  />
{/if}

<style>
  .settings-modal {
    --sm-bg: #131722;
    --sm-border: #2a2e39;
    --sm-divider: #2a2e39;
    --sm-text: #d1d4dc;
    --sm-secondary: #787b86;
    --sm-nav-active: #1e222d;
    --sm-nav-hover: rgba(255, 255, 255, 0.04);
    --sm-control-bg: #131722;
    --sm-control-muted: #1e222d;
    --sm-control-border: #363a45;
    --sm-check-bg: #d1d4dc;
    --sm-check-fg: #000000;
    --sm-check-border: #50535e;
    --sm-ok-bg: #d1d4dc;
    --sm-ok-fg: #000000;
    --sm-cancel-border: #50535e;
    --sm-checker-a: #2a2e39;
    --sm-checker-b: #1a1e29;
    --sm-shadow: 0 16px 48px rgba(0, 0, 0, 0.72), 0 0 0 1px #2a2e39;

    position: fixed;
    z-index: 100;
    width: 680px;
    max-width: calc(100vw - 32px);
    height: 590px;
    max-height: calc(100vh - 56px);
    display: flex;
    flex-direction: column;
    border-radius: 12px;
    color: var(--sm-text);
    background: var(--sm-bg);
    box-shadow: var(--sm-shadow);
    overflow: hidden;
    user-select: none;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .settings-modal.light {
    --sm-bg: #ffffff;
    --sm-border: #e0e3eb;
    --sm-divider: #ebebeb;
    --sm-text: #131722;
    --sm-secondary: #787b86;
    --sm-nav-active: #f2f2f2;
    --sm-nav-hover: rgba(0, 0, 0, 0.03);
    --sm-control-bg: #ffffff;
    --sm-control-muted: #f2f2f2;
    --sm-control-border: #e0e3eb;
    --sm-check-bg: #131722;
    --sm-check-fg: #ffffff;
    --sm-check-border: #8c919e;
    --sm-ok-bg: #131722;
    --sm-ok-fg: #ffffff;
    --sm-cancel-border: #131722;
    --sm-checker-a: #d5d8de;
    --sm-checker-b: #ffffff;
    --sm-shadow: 0 12px 40px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
  }

  /* Header */
  .modal-header {
    height: 60px;
    flex: 0 0 60px;
    padding: 0 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
    touch-action: none;
  }

  .settings-modal.dragging .modal-header {
    cursor: grabbing;
  }

  .modal-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.015em;
    color: var(--sm-text);
  }

  .close-button {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--sm-text);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .close-button:hover {
    background: var(--sm-nav-hover);
  }

  .close-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Body */
  .modal-body {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }

  .modal-nav {
    width: 212px;
    flex: 0 0 212px;
    padding: 4px 12px 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    height: 36px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--sm-text);
    background: transparent;
    font: inherit;
    font-size: 14px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .nav-item:hover:not(.active) {
    background: var(--sm-nav-hover);
  }

  .nav-item.active {
    background: var(--sm-nav-active);
    font-weight: 500;
  }

  .nav-item svg {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Content pane */
  .modal-content {
    flex: 1;
    min-width: 0;
    padding: 8px 24px 20px 18px;
    overflow-y: auto;
    scrollbar-width: none;
  }

  .modal-content::-webkit-scrollbar {
    display: none;
  }

  .settings-section + .settings-section {
    margin-top: 22px;
  }

  .section-label {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--sm-secondary);
  }

  .setting-row {
    min-height: 40px;
    display: grid;
    grid-template-columns: 168px 1fr;
    align-items: center;
    gap: 12px;
  }

  .setting-row.single {
    grid-template-columns: 1fr;
  }

  .setting-row.indented {
    padding-left: 24px;
    grid-template-columns: 144px 1fr;
  }

  .setting-row.single.indented {
    grid-template-columns: 1fr;
  }

  .row-label {
    font-size: 14px;
    color: var(--sm-text);
  }

  .row-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Custom checkbox */
  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    color: var(--sm-text);
    cursor: pointer;
  }

  .checkbox-label input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .checkbox-box {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border-radius: 4px;
    border: 1px solid var(--sm-check-border);
    background: transparent;
    display: grid;
    place-items: center;
    color: transparent;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .checkbox-box svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .checkbox-label input:checked + .checkbox-box {
    background: var(--sm-check-bg);
    border-color: var(--sm-check-bg);
    color: var(--sm-check-fg);
  }

  .checkbox-label input:focus-visible + .checkbox-box {
    outline: 1px solid var(--sm-text);
    outline-offset: 2px;
  }

  /* Select & swatch visual controls */
  .select-box {
    height: 34px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--sm-control-border);
    border-radius: 6px;
    background: var(--sm-control-bg);
    color: var(--sm-text);
    font-size: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .select-box.compact {
    width: 96px;
  }

  .select-box.wide {
    width: 148px;
  }

  .select-box.xl {
    width: 182px;
  }

  .select-box.muted {
    background: var(--sm-control-muted);
    border-color: transparent;
    color: var(--sm-secondary);
  }

  .select-box svg {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .swatch-box,
  .swatch-button {
    width: 34px;
    height: 34px;
    flex: 0 0 34px;
    padding: 4px;
    border: 1px solid var(--sm-control-border);
    border-radius: 6px;
    background: var(--sm-control-bg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .swatch-button {
    cursor: pointer;
    transition: border-color 150ms ease, opacity 150ms ease, box-shadow 150ms ease;
  }

  .swatch-button:hover {
    border-color: var(--sm-secondary);
  }

  .swatch-button.picker-open {
    border-color: #2962ff;
    box-shadow: 0 0 0 1px #2962ff;
  }

  .swatch-button.muted {
    opacity: 0.45;
  }

  .swatch-box::after,
  .swatch-button::after {
    content: '';
    width: 100%;
    height: 100%;
    border-radius: 4px;
    background: var(--swatch, transparent);
    border: 1px solid color-mix(in srgb, var(--sm-text) 10%, transparent);
  }

  .swatch-button::before {
    content: '';
    position: absolute;
    inset: 4px;
    border-radius: 4px;
    background-color: var(--sm-checker-b);
    background-image:
      linear-gradient(45deg, var(--sm-checker-a) 25%, transparent 25%),
      linear-gradient(-45deg, var(--sm-checker-a) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--sm-checker-a) 75%),
      linear-gradient(-45deg, transparent 75%, var(--sm-checker-a) 75%);
    background-size: 8px 8px;
    background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  }

  .swatch-button::after {
    position: relative;
    z-index: 1;
  }

  .swatch-box.checker::after {
    border: 0;
    background-color: var(--sm-checker-b);
    background-image:
      linear-gradient(45deg, var(--sm-checker-a) 25%, transparent 25%),
      linear-gradient(-45deg, var(--sm-checker-a) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--sm-checker-a) 75%),
      linear-gradient(-45deg, transparent 75%, var(--sm-checker-a) 75%);
    background-size: 8px 8px;
    background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  }

  .line-swatch {
    width: 74px;
    height: 34px;
    padding: 4px 8px 4px 5px;
    border: 1px solid var(--sm-control-border);
    border-radius: 6px;
    background: var(--sm-control-bg);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: background-color 150ms ease, border-color 150ms ease, opacity 150ms ease;
  }

  .line-swatch.muted {
    background: var(--sm-control-muted);
    border-color: var(--sm-control-border);
    opacity: 0.65;
  }

  .color-chip,
  .checker-chip {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
    border-radius: 4px;
  }

  .checker-chip {
    background-color: var(--sm-checker-b);
    background-image:
      linear-gradient(45deg, var(--sm-checker-a) 25%, transparent 25%),
      linear-gradient(-45deg, var(--sm-checker-a) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--sm-checker-a) 75%),
      linear-gradient(-45deg, transparent 75%, var(--sm-checker-a) 75%);
    background-size: 8px 8px;
    background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  }

  .checker-chip.filled-grid {
    background-image: none;
    background-color: color-mix(in srgb, var(--sm-text) 22%, transparent);
  }

  .dash-sample {
    flex: 1;
    height: 0;
    border-top: 1.5px dashed var(--sm-secondary);
  }

  .help-badge {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--sm-secondary);
    color: var(--sm-bg);
    font-size: 11px;
    font-weight: 700;
    display: grid;
    place-items: center;
    opacity: 0.7;
  }

  .placeholder-tab {
    padding: 48px 0;
    font-size: 13px;
    color: var(--sm-secondary);
  }

  /* Footer */
  .modal-footer {
    height: 68px;
    flex: 0 0 68px;
    padding: 0 20px;
    border-top: 1px solid var(--sm-divider);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .template-button {
    height: 34px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--sm-control-border);
    border-radius: 8px;
    background: transparent;
    color: var(--sm-text);
    font: inherit;
    font-size: 14px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .template-button:hover {
    background: var(--sm-nav-hover);
  }

  .template-button svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .cancel-button {
    height: 34px;
    padding: 0 16px;
    border: 1px solid var(--sm-cancel-border);
    border-radius: 8px;
    background: transparent;
    color: var(--sm-text);
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .cancel-button:hover {
    background: var(--sm-nav-hover);
  }

  .ok-button {
    height: 34px;
    padding: 0 18px;
    border: 0;
    border-radius: 8px;
    background: var(--sm-ok-bg);
    color: var(--sm-ok-fg);
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 150ms ease, background-color 150ms ease, color 150ms ease;
  }

  .ok-button:hover {
    opacity: 0.9;
  }
</style>
