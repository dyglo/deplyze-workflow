import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import {
  makeAttachmentId,
  makeNoteId,
  todayNairobiIso,
  type Note,
  type NoteAttachment
} from './types';

interface SavedImageResult {
  filename: string;
  path: string;
  mimeType: string;
}

export const NOTE_UNDO_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

const FALLBACK_KEY = 'deplyzeworkflow-notes-fallback';
const fallbackUrls = new Map<string, string>();
let cachedImagesDir: string | null = null;
const noteChangeListeners = new Set<() => void>();

export function subscribeNotesChanged(listener: () => void): () => void {
  noteChangeListeners.add(listener);
  return () => {
    noteChangeListeners.delete(listener);
  };
}

export function notifyNotesChanged(): void {
  for (const listener of noteChangeListeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function extFromMime(mime: string, name?: string): string {
  const lower = mime.toLowerCase();
  if (lower === 'image/png') return 'png';
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
  if (lower === 'image/webp') return 'webp';
  if (lower === 'image/gif') return 'gif';
  if (name) {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif') {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return 'png';
}

export async function loadNotes(): Promise<Note[]> {
  if (isTauri()) {
    return await invoke<Note[]>('notes_load');
  }
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as Note[]) : [];
  } catch {
    return [];
  }
}

export async function saveNotes(notes: Note[]): Promise<void> {
  if (isTauri()) {
    await invoke('notes_save', { notes });
    return;
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(notes));
  }
}

export async function getImagesDir(): Promise<string> {
  if (!isTauri()) return '';
  if (cachedImagesDir) return cachedImagesDir;
  cachedImagesDir = await invoke<string>('notes_get_images_dir');
  return cachedImagesDir;
}

export function getImageUrl(filename: string, imagesDir: string): string {
  if (!isTauri()) {
    return fallbackUrls.get(filename) ?? '';
  }
  if (!imagesDir) return '';
  const sep = imagesDir.includes('\\') ? '\\' : '/';
  const cleanDir = imagesDir.endsWith('\\') || imagesDir.endsWith('/') ? imagesDir : `${imagesDir}${sep}`;
  return convertFileSrc(`${cleanDir}${filename}`);
}

export async function saveImageFromBlob(
  blob: Blob,
  noteId: string,
  date: string,
  originalName?: string
): Promise<NoteAttachment> {
  const ext = extFromMime(blob.type, originalName);
  const now = new Date().toISOString();

  if (isTauri()) {
    const buffer = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    const saved = await invoke<SavedImageResult>('notes_save_image_bytes', {
      bytes,
      ext,
      noteId,
      date
    });
    return {
      id: makeAttachmentId(),
      filename: saved.filename,
      mimeType: saved.mimeType,
      createdAt: now
    };
  }

  const filename = `${date}_${noteId}_${Date.now()}.${ext}`;
  fallbackUrls.set(filename, URL.createObjectURL(blob));
  return {
    id: makeAttachmentId(),
    filename,
    mimeType: blob.type || `image/${ext}`,
    createdAt: now
  };
}

export async function saveImageFromPath(
  sourcePath: string,
  noteId: string,
  date: string
): Promise<NoteAttachment> {
  const now = new Date().toISOString();
  const saved = await invoke<SavedImageResult>('notes_copy_image_file', {
    sourcePath,
    noteId,
    date
  });
  return {
    id: makeAttachmentId(),
    filename: saved.filename,
    mimeType: saved.mimeType,
    createdAt: now
  };
}

export async function deleteImageFile(filename: string): Promise<void> {
  if (isTauri()) {
    await invoke('notes_delete_image', { filename });
    return;
  }
  const url = fallbackUrls.get(filename);
  if (url) {
    URL.revokeObjectURL(url);
    fallbackUrls.delete(filename);
  }
}

export function isSupportedImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif';
}

export function isDeletedWithinUndoWindow(note: Note, nowMs = Date.now()): boolean {
  if (!note.deletedAt) return false;
  const deletedMs = Date.parse(note.deletedAt);
  if (!Number.isFinite(deletedMs)) return false;
  return nowMs - deletedMs < NOTE_UNDO_WINDOW_MS;
}

export function getRecentDeletedNotes(notes: Note[], nowMs = Date.now()): Note[] {
  return notes
    .filter((n) => isDeletedWithinUndoWindow(n, nowMs))
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

export async function purgeExpiredDeletedNotes(
  notes: Note[],
  nowMs = Date.now()
): Promise<{ notes: Note[]; purgedCount: number }> {
  const expired: Note[] = [];
  const kept: Note[] = [];

  for (const n of notes) {
    if (n.deletedAt && !isDeletedWithinUndoWindow(n, nowMs)) {
      expired.push(n);
    } else {
      kept.push(n);
    }
  }

  if (expired.length === 0) {
    return { notes, purgedCount: 0 };
  }

  await saveNotes(kept);
  for (const n of expired) {
    for (const att of n.attachments) {
      try {
        await deleteImageFile(att.filename);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  notifyNotesChanged();
  return { notes: kept, purgedCount: expired.length };
}

export async function permanentlyDeleteNote(notes: Note[], noteId: string): Promise<Note[]> {
  const target = notes.find((n) => n.id === noteId);
  if (!target) return notes;

  const filenames = target.attachments.map((a) => a.filename);
  const remaining = notes.filter((n) => n.id !== noteId);
  await saveNotes(remaining);

  for (const filename of filenames) {
    try {
      await deleteImageFile(filename);
    } catch {
      // Ignore cleanup errors
    }
  }
  notifyNotesChanged();
  return remaining;
}

export async function restoreMostRecentDeletedNote(): Promise<Note | null> {
  const loaded = await loadNotes();
  const { notes } = await purgeExpiredDeletedNotes(loaded);
  const recent = getRecentDeletedNotes(notes);
  if (recent.length === 0) return null;

  const target = recent[0];
  const restored: Note = {
    ...target,
    updatedAt: new Date().toISOString()
  };
  delete restored.deletedAt;

  const updated = notes.map((n) => (n.id === restored.id ? restored : n));
  await saveNotes(updated);
  notifyNotesChanged();
  return restored;
}

export async function saveNewsItemToNotes(params: {
  title: string;
  body: string;
  symbol: string;
  fullSymbol: string;
}): Promise<Note> {
  const loaded = await loadNotes();
  const { notes } = await purgeExpiredDeletedNotes(loaded);
  const now = new Date().toISOString();
  const note: Note = {
    id: makeNoteId(),
    title: params.title.trim().slice(0, 120) || `News — ${params.symbol}`,
    body: params.body.trim(),
    date: todayNairobiIso(),
    symbol: params.symbol || 'XAUUSD',
    fullSymbol: params.fullSymbol || params.symbol || 'OANDA:XAUUSD',
    pinned: false,
    attachments: [],
    createdAt: now,
    updatedAt: now
  };
  await saveNotes([note, ...notes]);
  notifyNotesChanged();
  return note;
}
