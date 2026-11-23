declare namespace svelteHTML {
  interface HTMLAttributes<T> {
    'tv-advanced-chart'?: T;
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    'tv-advanced-chart': Record<string, unknown>;
  }
}
