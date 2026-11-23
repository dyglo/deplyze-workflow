<script lang="ts">
  import { getImageUrl } from '../notes/api';
  import type { NoteAttachment } from '../notes/types';

  interface Props {
    attachments: NoteAttachment[];
    initialIndex: number;
    imagesDir: string;
    metaLabel?: string;
    onDelete?: (attachment: NoteAttachment) => void;
    onClose: () => void;
  }

  let { attachments, initialIndex, imagesDir, metaLabel = '', onDelete, onClose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let index = $state(initialIndex);
  let zoomed = $state(false);

  const safeIndex = $derived(
    attachments.length === 0 ? 0 : Math.min(Math.max(0, index), attachments.length - 1)
  );
  const current = $derived(attachments[safeIndex]);
  const currentUrl = $derived(current ? getImageUrl(current.filename, imagesDir) : '');

  function prev() {
    if (attachments.length <= 1) return;
    zoomed = false;
    index = (safeIndex - 1 + attachments.length) % attachments.length;
  }

  function next() {
    if (attachments.length <= 1) return;
    zoomed = false;
    index = (safeIndex + 1) % attachments.length;
  }

  function handleDelete() {
    if (!current || !onDelete) return;
    const target = current;
    if (attachments.length <= 1) {
      onDelete(target);
      onClose();
      return;
    }
    onDelete(target);
    zoomed = false;
    if (safeIndex >= attachments.length - 1) {
      index = Math.max(0, safeIndex - 1);
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeyDown} />

{#if current}
  <div
    class="lightbox-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="Screenshot preview"
    tabindex="-1"
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <header class="lightbox-header">
      <div class="lightbox-meta">
        {#if attachments.length > 1}
          <span class="lightbox-counter">{safeIndex + 1} / {attachments.length}</span>
        {/if}
        {#if metaLabel}
          <span class="lightbox-label">{metaLabel}</span>
        {/if}
      </div>

      <div class="lightbox-actions">
        <button
          class="lb-button"
          type="button"
          aria-label={zoomed ? 'Fit to screen' : 'Zoom to actual size'}
          title={zoomed ? 'Fit' : '100%'}
          onclick={() => (zoomed = !zoomed)}
        >
          {#if zoomed}
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M8 3.5V8H3.5M12 3.5V8h4.5M8 16.5V12H3.5M12 16.5V12h4.5" />
            </svg>
          {:else}
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 8V3.5H8M16.5 8V3.5H12M3.5 12v4.5H8M16.5 12v4.5H12" />
            </svg>
          {/if}
        </button>

        {#if onDelete}
          <button
            class="lb-button"
            type="button"
            aria-label="Delete screenshot"
            title="Delete screenshot"
            onclick={handleDelete}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <ellipse cx="10" cy="5.25" rx="4.75" ry="1.75" />
              <path d="M5.25 5.25l.9 9.4a2.35 2.35 0 0 0 2.35 2.1h3a2.35 2.35 0 0 0 2.35-2.1l.9-9.4" />
              <path d="m8.6 10.35 2.8 2.8m0-2.8-2.8 2.8" />
            </svg>
          </button>
        {/if}

        <button
          class="lb-button"
          type="button"
          aria-label="Close preview"
          title="Close (Esc)"
          onclick={onClose}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5 5 10 10m0-10L5 15" />
          </svg>
        </button>
      </div>
    </header>

    {#if attachments.length > 1}
      <button
        class="lb-nav prev"
        type="button"
        aria-label="Previous screenshot"
        onclick={prev}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m12.25 5.25-4.75 4.75 4.75 4.75" />
        </svg>
      </button>

      <button
        class="lb-nav next"
        type="button"
        aria-label="Next screenshot"
        onclick={next}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m7.75 5.25 4.75 4.75-4.75 4.75" />
        </svg>
      </button>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="lightbox-stage"
      class:zoomed
      onpointerdown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <img
        class="lightbox-image"
        class:zoomed
        src={currentUrl}
        alt="Note screenshot"
        onclick={() => (zoomed = !zoomed)}
      />
    </div>
  </div>
{/if}

<style>
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    z-index: 260;
    display: flex;
    flex-direction: column;
    color: #f0f0f0;
    background: rgba(12, 12, 12, 0.86);
    -webkit-backdrop-filter: blur(20px) saturate(130%);
    backdrop-filter: blur(20px) saturate(130%);
    user-select: none;
  }

  .lightbox-header {
    height: 52px;
    flex: 0 0 52px;
    padding: 0 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .lightbox-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }

  .lightbox-counter {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #f0f0f0;
  }

  .lightbox-label {
    color: #8c8c92;
  }

  .lightbox-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .lb-button {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: #f0f0f0;
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .lb-button:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  .lb-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .lb-nav {
    position: fixed;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2;
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #f0f0f0;
    background: rgba(24, 24, 24, 0.8);
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .lb-nav:hover {
    background: rgba(48, 48, 48, 0.92);
  }

  .lb-nav.prev {
    left: 20px;
  }

  .lb-nav.next {
    right: 20px;
  }

  .lb-nav svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .lightbox-stage {
    flex: 1;
    min-height: 0;
    padding: 8px 64px 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .lightbox-stage.zoomed {
    display: block;
    overflow: auto;
    padding: 20px;
    text-align: center;
  }

  .lightbox-image {
    max-width: 100%;
    max-height: 100%;
    border-radius: 8px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65);
    cursor: zoom-in;
    object-fit: contain;
  }

  .lightbox-image.zoomed {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
</style>
