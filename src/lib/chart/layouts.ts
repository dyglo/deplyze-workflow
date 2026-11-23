export type LayoutId =
  | '1-single'
  | '2-vertical'
  | '2-horizontal'
  | '3-columns'
  | '3-rows'
  | '3-left-big'
  | '3-right-big'
  | '3-bottom-big'
  | '3-top-big'
  | '4-grid'
  | '4-rows'
  | '4-columns'
  | '4-left-big'
  | '4-right-big'
  | '4-top-big'
  | '4-bottom-big'
  | '4-cols-right-split'
  | '4-cols-left-split'
  | '4-top-split-rows';

export interface PanePlacement {
  gridColumn: string;
  gridRow: string;
}

export interface ChartLayoutDef {
  id: LayoutId;
  count: 1 | 2 | 3 | 4;
  label: string;
  columns: string;
  rows: string;
  panes: PanePlacement[];
  /** Internal divider SVG path inside a `viewBox="0 0 20 16"` outer rect `(2,2,16,12)` */
  iconDividers: string;
}

export const LAYOUT_STORAGE_KEY = 'deplyzeworkflow-layout';

export const CHART_LAYOUTS: ChartLayoutDef[] = [
  // Row 1 (1 pane)
  {
    id: '1-single',
    count: 1,
    label: 'Single chart',
    columns: '1fr',
    rows: '1fr',
    panes: [{ gridColumn: '1', gridRow: '1' }],
    iconDividers: ''
  },

  // Row 2 (2 panes)
  {
    id: '2-vertical',
    count: 2,
    label: '2 charts vertical',
    columns: '1fr 1fr',
    rows: '1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' }
    ],
    iconDividers: 'M10 2v12'
  },
  {
    id: '2-horizontal',
    count: 2,
    label: '2 charts horizontal',
    columns: '1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' }
    ],
    iconDividers: 'M2 8h16'
  },

  // Row 3 (3 panes)
  {
    id: '3-columns',
    count: 3,
    label: '3 columns',
    columns: '1fr 1fr 1fr',
    rows: '1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '3', gridRow: '1' }
    ],
    iconDividers: 'M7.33 2v12M12.67 2v12'
  },
  {
    id: '3-rows',
    count: 3,
    label: '3 rows',
    columns: '1fr',
    rows: '1fr 1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '1', gridRow: '3' }
    ],
    iconDividers: 'M2 6h16M2 10h16'
  },
  {
    id: '3-left-big',
    count: 3,
    label: '1 left, 2 right',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1 / 3' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '2', gridRow: '2' }
    ],
    iconDividers: 'M10 2v12M10 8h8'
  },
  {
    id: '3-right-big',
    count: 3,
    label: '2 left, 1 right',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '2', gridRow: '1 / 3' }
    ],
    iconDividers: 'M10 2v12M2 8h8'
  },
  {
    id: '3-bottom-big',
    count: 3,
    label: '2 top, 1 bottom',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '1 / 3', gridRow: '2' }
    ],
    iconDividers: 'M2 8h16M10 2v6'
  },
  {
    id: '3-top-big',
    count: 3,
    label: '1 top, 2 bottom',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1 / 3', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '2', gridRow: '2' }
    ],
    iconDividers: 'M2 8h16M10 8v6'
  },

  // Row 4 (4 panes)
  {
    id: '4-grid',
    count: 4,
    label: '2x2 grid',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '2', gridRow: '2' }
    ],
    iconDividers: 'M10 2v12M2 8h16'
  },
  {
    id: '4-rows',
    count: 4,
    label: '4 rows',
    columns: '1fr',
    rows: '1fr 1fr 1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '1', gridRow: '3' },
      { gridColumn: '1', gridRow: '4' }
    ],
    iconDividers: 'M2 5h16M2 8h16M2 11h16'
  },
  {
    id: '4-columns',
    count: 4,
    label: '4 columns',
    columns: '1fr 1fr 1fr 1fr',
    rows: '1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '3', gridRow: '1' },
      { gridColumn: '4', gridRow: '1' }
    ],
    iconDividers: 'M6 2v12M10 2v12M14 2v12'
  },
  {
    id: '4-left-big',
    count: 4,
    label: '1 left, 3 right',
    columns: '1fr 1fr',
    rows: '1fr 1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1 / 4' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '2', gridRow: '2' },
      { gridColumn: '2', gridRow: '3' }
    ],
    iconDividers: 'M10 2v12M10 6h8M10 10h8'
  },
  {
    id: '4-right-big',
    count: 4,
    label: '3 left, 1 right',
    columns: '1fr 1fr',
    rows: '1fr 1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '1', gridRow: '3' },
      { gridColumn: '2', gridRow: '1 / 4' }
    ],
    iconDividers: 'M10 2v12M2 6h8M2 10h8'
  },
  {
    id: '4-top-big',
    count: 4,
    label: '1 top, 3 bottom',
    columns: '1fr 1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1 / 4', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '2', gridRow: '2' },
      { gridColumn: '3', gridRow: '2' }
    ],
    iconDividers: 'M2 8h16M7.33 8v6M12.67 8v6'
  },
  {
    id: '4-bottom-big',
    count: 4,
    label: '3 top, 1 bottom',
    columns: '1fr 1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '3', gridRow: '1' },
      { gridColumn: '1 / 4', gridRow: '2' }
    ],
    iconDividers: 'M2 8h16M7.33 2v6M12.67 2v6'
  },
  {
    id: '4-cols-right-split',
    count: 4,
    label: '2 columns left, 2 stacked right',
    columns: '1fr 1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1 / 3' },
      { gridColumn: '2', gridRow: '1 / 3' },
      { gridColumn: '3', gridRow: '1' },
      { gridColumn: '3', gridRow: '2' }
    ],
    iconDividers: 'M7.33 2v12M12.67 2v12M12.67 8h5.33'
  },
  {
    id: '4-cols-left-split',
    count: 4,
    label: '2 stacked left, 2 columns right',
    columns: '1fr 1fr 1fr',
    rows: '1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '2', gridRow: '1 / 3' },
      { gridColumn: '3', gridRow: '1 / 3' }
    ],
    iconDividers: 'M7.33 2v12M12.67 2v12M2 8h5.33'
  },
  {
    id: '4-top-split-rows',
    count: 4,
    label: '2 top split, 2 rows below',
    columns: '1fr 1fr',
    rows: '1fr 1fr 1fr',
    panes: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '1 / 3', gridRow: '2' },
      { gridColumn: '1 / 3', gridRow: '3' }
    ],
    iconDividers: 'M2 6h16M2 10h16M10 2v4'
  }
];

export const LAYOUT_GROUPS: { count: 1 | 2 | 3 | 4; items: ChartLayoutDef[] }[] = [1, 2, 3, 4].map(
  (count) => ({
    count: count as 1 | 2 | 3 | 4,
    items: CHART_LAYOUTS.filter((l) => l.count === count)
  })
);

export function getLayoutById(id: LayoutId): ChartLayoutDef {
  return CHART_LAYOUTS.find((l) => l.id === id) ?? CHART_LAYOUTS[0];
}

export function loadLayoutId(): LayoutId {
  if (typeof localStorage === 'undefined') return '1-single';
  try {
    const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (saved && CHART_LAYOUTS.some((l) => l.id === saved)) {
      return saved as LayoutId;
    }
  } catch {
    // Ignore storage errors
  }
  return '1-single';
}

export function saveLayoutId(id: LayoutId): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, id);
  } catch {
    // Ignore storage errors
  }
}
