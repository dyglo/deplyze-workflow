export type CountryCode =
  | 'AU'
  | 'ID'
  | 'IN'
  | 'DE'
  | 'EU'
  | 'GB'
  | 'US'
  | 'JP'
  | 'CA'
  | 'CH'
  | 'CN'
  | 'NZ';

/**
 * Bundled 16x16 circular SVG flags (no network fetches, safe for Windows WebView2).
 * Each entry contains inner SVG markup for a `viewBox="0 0 16 16"` circular clip.
 */
export const FLAG_SVGS: Record<CountryCode, string> = {
  AU: `
    <rect width="16" height="16" fill="#012169"/>
    <path d="M0 0h8v8H0z" fill="#012169"/>
    <path d="M0 0l8 8M8 0L0 8" stroke="#fff" stroke-width="1.4"/>
    <path d="M0 0l8 8M8 0L0 8" stroke="#C8102E" stroke-width="0.7"/>
    <path d="M4 0v8M0 4h8" stroke="#fff" stroke-width="2.2"/>
    <path d="M4 0v8M0 4h8" stroke="#C8102E" stroke-width="1.2"/>
    <circle cx="4.2" cy="11.8" r="1.2" fill="#fff"/>
    <circle cx="11.8" cy="4.2" r="0.8" fill="#fff"/>
    <circle cx="13.5" cy="7.2" r="0.7" fill="#fff"/>
    <circle cx="10.2" cy="8.2" r="0.7" fill="#fff"/>
    <circle cx="11.8" cy="12" r="0.9" fill="#fff"/>
  `,
  ID: `
    <rect width="16" height="8" fill="#CE1126"/>
    <rect y="8" width="16" height="8" fill="#FFFFFF"/>
  `,
  IN: `
    <rect width="16" height="5.33" fill="#FF9933"/>
    <rect y="5.33" width="16" height="5.34" fill="#FFFFFF"/>
    <rect y="10.67" width="16" height="5.33" fill="#138808"/>
    <circle cx="8" cy="8" r="1.75" fill="none" stroke="#000080" stroke-width="0.7"/>
    <circle cx="8" cy="8" r="0.45" fill="#000080"/>
  `,
  DE: `
    <rect width="16" height="5.33" fill="#111111"/>
    <rect y="5.33" width="16" height="5.34" fill="#DD0000"/>
    <rect y="10.67" width="16" height="5.33" fill="#FFCE00"/>
  `,
  EU: `
    <rect width="16" height="16" fill="#003399"/>
    <g fill="#FFCC00">
      <circle cx="8" cy="3.2" r="0.7"/>
      <circle cx="10.4" cy="3.85" r="0.7"/>
      <circle cx="12.15" cy="5.6" r="0.7"/>
      <circle cx="12.8" cy="8" r="0.7"/>
      <circle cx="12.15" cy="10.4" r="0.7"/>
      <circle cx="10.4" cy="12.15" r="0.7"/>
      <circle cx="8" cy="12.8" r="0.7"/>
      <circle cx="5.6" cy="12.15" r="0.7"/>
      <circle cx="3.85" cy="10.4" r="0.7"/>
      <circle cx="3.2" cy="8" r="0.7"/>
      <circle cx="3.85" cy="5.6" r="0.7"/>
      <circle cx="5.6" cy="3.85" r="0.7"/>
    </g>
  `,
  GB: `
    <rect width="16" height="16" fill="#012169"/>
    <path d="M0 0l16 16M16 0L0 16" stroke="#fff" stroke-width="2.6"/>
    <path d="M0 0l16 16M16 0L0 16" stroke="#C8102E" stroke-width="1.2"/>
    <path d="M8 0v16M0 8h16" stroke="#fff" stroke-width="4.2"/>
    <path d="M8 0v16M0 8h16" stroke="#C8102E" stroke-width="2.4"/>
  `,
  US: `
    <rect width="16" height="16" fill="#FFFFFF"/>
    <path d="M0 0h16v1.23H0zm0 2.46h16v1.23H0zm0 2.46h16v1.23H0zm0 2.46h16v1.23H0zm0 2.46h16v1.23H0zm0 2.46h16v1.23H0zm0 2.46h16V16H0z" fill="#B22234"/>
    <rect width="8" height="8.6" fill="#3C3B6E"/>
    <g fill="#FFFFFF">
      <circle cx="1.8" cy="1.8" r="0.55"/>
      <circle cx="4" cy="1.8" r="0.55"/>
      <circle cx="6.2" cy="1.8" r="0.55"/>
      <circle cx="2.9" cy="3.6" r="0.55"/>
      <circle cx="5.1" cy="3.6" r="0.55"/>
      <circle cx="1.8" cy="5.4" r="0.55"/>
      <circle cx="4" cy="5.4" r="0.55"/>
      <circle cx="6.2" cy="5.4" r="0.55"/>
      <circle cx="2.9" cy="7.2" r="0.55"/>
      <circle cx="5.1" cy="7.2" r="0.55"/>
    </g>
  `,
  JP: `
    <rect width="16" height="16" fill="#FFFFFF"/>
    <circle cx="8" cy="8" r="4.2" fill="#BC002D"/>
  `,
  CA: `
    <rect width="4.2" height="16" fill="#D80621"/>
    <rect x="4.2" width="7.6" height="16" fill="#FFFFFF"/>
    <rect x="11.8" width="4.2" height="16" fill="#D80621"/>
    <path d="M8 4.4l.75 2 1.5-.4-.45 1.4 1.15.6-.75 1.35h-1.6l-.15 2h-.9l-.15-2H5.8L5.05 8l1.15-.6-.45-1.4 1.5.4Z" fill="#D80621"/>
  `,
  CH: `
    <rect width="16" height="16" fill="#D52B1E"/>
    <rect x="6.5" y="3.5" width="3" height="9" fill="#FFFFFF"/>
    <rect x="3.5" y="6.5" width="9" height="3" fill="#FFFFFF"/>
  `,
  CN: `
    <rect width="16" height="16" fill="#DE2910"/>
    <polygon points="4.5,3.2 5.05,4.9 6.8,4.9 5.38,5.92 5.92,7.6 4.5,6.55 3.08,7.6 3.62,5.92 2.2,4.9 3.95,4.9" fill="#FFDE00"/>
    <circle cx="8.3" cy="3.1" r="0.7" fill="#FFDE00"/>
    <circle cx="9.6" cy="4.4" r="0.7" fill="#FFDE00"/>
    <circle cx="9.6" cy="6.2" r="0.7" fill="#FFDE00"/>
    <circle cx="8.3" cy="7.5" r="0.7" fill="#FFDE00"/>
  `,
  NZ: `
    <rect width="16" height="16" fill="#012169"/>
    <path d="M0 0h8v8H0z" fill="#012169"/>
    <path d="M0 0l8 8M8 0L0 8" stroke="#fff" stroke-width="1.4"/>
    <path d="M0 0l8 8M8 0L0 8" stroke="#C8102E" stroke-width="0.7"/>
    <path d="M4 0v8M0 4h8" stroke="#fff" stroke-width="2.2"/>
    <path d="M4 0v8M0 4h8" stroke="#C8102E" stroke-width="1.2"/>
    <circle cx="11.8" cy="4.3" r="1.15" fill="#fff"/>
    <circle cx="11.8" cy="4.3" r="0.7" fill="#CC142B"/>
    <circle cx="13.7" cy="7.2" r="1.05" fill="#fff"/>
    <circle cx="13.7" cy="7.2" r="0.65" fill="#CC142B"/>
    <circle cx="10.0" cy="7.7" r="1.05" fill="#fff"/>
    <circle cx="10.0" cy="7.7" r="0.65" fill="#CC142B"/>
    <circle cx="11.8" cy="11.8" r="1.25" fill="#fff"/>
    <circle cx="11.8" cy="11.8" r="0.8" fill="#CC142B"/>
  `
};
