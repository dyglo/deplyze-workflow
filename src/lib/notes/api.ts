import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { makeAttachmentId, type Note, type NoteAttachment } from './types';

interface SavedImageResult {
  filename: string;
  path: string;
  mimeType: string;
}

const FALLBACK_KEY = 'deplyzeworkflow-notes-fallback';
const fallbackUrls = new Map<string, string>();
let cachedImagesDir: string | null = null;

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
