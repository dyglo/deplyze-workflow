<script lang="ts">
  export let theme: 'dark' | 'light';
  export let onToggle: () => void;
</script>

<button
  class="theme-toggle"
  type="button"
  aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
  on:click={onToggle}
>
  <span aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span>
</button>

<style>
  .theme-toggle {
    width: 64px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid currentColor;
    border-radius: 999px;
    color: inherit;
    background: transparent;
    font: inherit;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .theme-toggle span {
    display: block;
    font-size: 15px;
    line-height: 1;
  }

  .theme-toggle:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: 3px;
  }
</style>
