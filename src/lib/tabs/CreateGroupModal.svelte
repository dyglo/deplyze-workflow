<script lang="ts">
  interface Props {
    theme: 'dark' | 'light';
    onCreate: (name: string) => void;
    onClose: () => void;
  }

  let { theme, onCreate, onClose }: Props = $props();

  let groupName = $state('');
  let inputEl: HTMLInputElement | undefined = $state();

  const trimmed = $derived(groupName.trim());

  $effect(() => {
    inputEl?.focus();
  });

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!trimmed) return;
    onCreate(trimmed);
    onClose();
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeyDown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-backdrop"
  class:light={theme === 'light'}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="create-group-modal"
    class:light={theme === 'light'}
    role="dialog"
    aria-modal="true"
    aria-labelledby="create-group-title"
  >
    <button
      class="close-button"
      type="button"
      aria-label="Close dialog"
      onclick={onClose}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5 5 10 10m0-10L5 15" />
      </svg>
    </button>

    <form onsubmit={handleSubmit}>
      <h2 id="create-group-title" class="modal-title">Create group</h2>

      <label class="field-label" for="new-group-name">New group name</label>
      <input
        bind:this={inputEl}
        id="new-group-name"
        class="group-input"
        type="text"
        placeholder="My group"
        maxlength={40}
        bind:value={groupName}
      />

      <div class="modal-actions">
        <button class="cancel-button" type="button" onclick={onClose}>Cancel</button>
        <button class="create-button" type="submit" disabled={!trimmed}>Create</button>
      </div>
    </form>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 220;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.48);
  }

  .modal-backdrop.light {
    background: rgba(0, 0, 0, 0.22);
  }

  .create-group-modal {
    --cg-bg: #1f1f1f;
    --cg-text: #f0f0f0;
    --cg-secondary: #8e929b;
    --cg-input-bg: #1f1f1f;
    --cg-input-border: #434651;
    --cg-cancel-border: #4a4a4a;
    --cg-cancel-hover: rgba(255, 255, 255, 0.08);
    --cg-disabled-bg: #303030;
    --cg-disabled-fg: #6b6b6b;
    --cg-submit-bg: #f2f2f2;
    --cg-submit-fg: #111111;
    --cg-shadow: 0 18px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px #323232;

    position: relative;
    width: 392px;
    max-width: calc(100vw - 32px);
    padding: 24px;
    border-radius: 10px;
    color: var(--cg-text);
    background: var(--cg-bg);
    box-shadow: var(--cg-shadow);
    user-select: none;
  }

  .create-group-modal.light {
    --cg-bg: #ffffff;
    --cg-text: #131722;
    --cg-secondary: #6a6d78;
    --cg-input-bg: #ffffff;
    --cg-input-border: #d1d4dc;
    --cg-cancel-border: #d1d4dc;
    --cg-cancel-hover: rgba(0, 0, 0, 0.04);
    --cg-disabled-bg: #ebebeb;
    --cg-disabled-fg: #9a9da6;
    --cg-submit-bg: #131722;
    --cg-submit-fg: #ffffff;
    --cg-shadow: 0 14px 40px rgba(0, 0, 0, 0.16), 0 1px 4px rgba(0, 0, 0, 0.08);
  }

  .close-button {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    display: grid;
    place-items: center;
    color: var(--cg-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .close-button:hover {
    color: var(--cg-text);
    background: var(--cg-cancel-hover);
  }

  .close-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .modal-title {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--cg-text);
  }

  .field-label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--cg-secondary);
  }

  .group-input {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--cg-input-border);
    border-radius: 6px;
    color: var(--cg-text);
    background: var(--cg-input-bg);
    font: inherit;
    font-size: 14px;
    outline: none;
    transition: border-color 150ms ease;
  }

  .group-input::placeholder {
    color: var(--cg-secondary);
  }

  .group-input:focus {
    border-color: #2962ff;
    box-shadow: 0 0 0 1px #2962ff;
  }

  .modal-actions {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .cancel-button {
    height: 34px;
    padding: 0 16px;
    border: 1px solid var(--cg-cancel-border);
    border-radius: 6px;
    color: var(--cg-text);
    background: transparent;
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .cancel-button:hover {
    background: var(--cg-cancel-hover);
  }

  .create-button {
    height: 34px;
    padding: 0 16px;
    border: 0;
    border-radius: 6px;
    color: var(--cg-submit-fg);
    background: var(--cg-submit-bg);
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 150ms ease, background-color 150ms ease, color 150ms ease;
  }

  .create-button:hover:not(:disabled) {
    opacity: 0.9;
  }

  .create-button:disabled {
    color: var(--cg-disabled-fg);
    background: var(--cg-disabled-bg);
    cursor: default;
  }
</style>
