# DeplyzeWorkflow

A Tauri 2 desktop charting and trading workflow app built with Svelte 5, Vite, TypeScript, and Rust, paired with a Node.js/TypeScript backend API for right-sidebar workspace features (economic calendar, tasks, notes, and alerts).

## Features

- Multi-tab and grouped TradingView workspace in the custom title bar with live symbol, price, and percent-change sync
- Multi-chart layouts (1–4 panes across 19 TradingView layout presets)
- Draggable Chart Settings modal with persistent grid line toggles and full candle customization
- Right-side icon rail with a resizable Calendar panel
- System, Dark, and Light themes via the title bar application menu

## Requirements

- Node.js 20+ and npm
- Rust toolchain
- Windows WebView2 (included with supported Windows installations)

## Run in development

```bash
npm install
npm run tauri:dev
```

## Check and build desktop app

```bash
npm run check
npm run build
npm run tauri:build
```

The built executable (`deplyzeworkflow.exe`) and Windows installer (`DeplyzeWorkflow`) are written under `src-tauri/target/release/` and `src-tauri/target/release/bundle/`.

## Backend API (`server/`)

```bash
cd server
npm install
npm run dev
```
