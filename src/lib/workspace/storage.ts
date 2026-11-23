import { invoke, isTauri } from '@tauri-apps/api/core';

const DEFAULT_API_BASE = 'https://deplyze-workflow-api.onrender.com';

export function getApiBaseUrl(): string {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configured = metaEnv?.VITE_API_BASE_URL?.trim();
  const base = configured && configured.length > 0 ? configured : DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

export function makeWorkspaceId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 10)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function loadWorkspaceJson<T>(key: string, fallback: T): Promise<T> {
  if (isTauri()) {
    try {
      const raw = await invoke<string | null>('workspace_load_json', { key });
      if (raw) return JSON.parse(raw) as T;
    } catch {
      // fall through
    }
  }
  try {
    const raw = localStorage.getItem(`deplyzeworkflow.ws.${key}`);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  return fallback;
}

export async function saveWorkspaceJson<T>(key: string, value: T): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (isTauri()) {
    try {
      await invoke('workspace_save_json', { key, content: serialized });
      return;
    } catch {
      // fall through
    }
  }
  try {
    localStorage.setItem(`deplyzeworkflow.ws.${key}`, serialized);
  } catch {
    // ignore
  }
}

export async function sendDesktopNotification(title: string, body: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('notify_desktop', { title, body });
      return;
    } catch {
      // fall through to Web Notification API
    }
  }
  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') new Notification(title, { body });
      }
    } catch {
      // ignore
    }
  }
}

/** Plays a clean, quiet two-tone trading alert chime using Web Audio API (zero external assets). */
export function playAlertChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [880, 1174.66]; // A5 -> D6 clean harmonic interval
    for (let i = 0; i < notes.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(notes[i], now + i * 0.13);
      gain.gain.setValueAtTime(0.0001, now + i * 0.13);
      gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.13 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.13);
      osc.stop(now + i * 0.13 + 0.35);
    }

    setTimeout(() => {
      void ctx.close();
    }, 900);
  } catch {
    // ignore autoplay restriction
  }
}
