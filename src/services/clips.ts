import { openDB, type IDBPDatabase } from "idb";
import { create } from "zustand";
import { makeZip } from "@/services/zip";

/**
 * Pass clips, kept on this device so they survive a reload and can be
 * downloaded together after a drive. A separate database from the camera
 * data, so adding it never has to migrate an existing install.
 */
export interface Clip {
  id: string;
  at: number;
  name: string;
  mime: string;
  blob: Blob;
}

/** Oldest clips go first past this; each is a few megabytes. */
const KEEP = 80;

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  dbp ??= openDB("sc-alpr-clips", 1, {
    upgrade(d) {
      d.createObjectStore("clips", { keyPath: "id" });
    },
  });
  return dbp;
}

export async function saveClip(clip: Clip): Promise<void> {
  try {
    const d = await db();
    await d.put("clips", clip);
    const all = (await d.getAll("clips")) as Clip[];
    const extra = all.sort((a, b) => a.at - b.at).slice(0, Math.max(0, all.length - KEEP));
    for (const c of extra) await d.delete("clips", c.id);
  } catch {
    // Storage full or blocked: the clip still plays this session.
  }
}

export async function listClips(): Promise<Clip[]> {
  try {
    const all = (await (await db()).getAll("clips")) as Clip[];
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function deleteClip(id: string): Promise<void> {
  try {
    await (await db()).delete("clips", id);
  } catch {
    // Already gone.
  }
}

export function clipExtension(mime: string): string {
  return /mp4/i.test(mime) ? "mp4" : "webm";
}

/** "pass-2026-11-10-1432-I-126-E-MM-2.7.webm" */
export function clipFileName(c: Clip): string {
  const d = new Date(c.at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const where = c.name.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `pass-${stamp}-${where}.${clipExtension(c.mime)}`;
}

/** Hand a file to the browser to save. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export interface LoadedClip extends Clip {
  /** Object URL for playing it in the page. */
  url: string;
}

interface ClipsState {
  clips: LoadedClip[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (blob: Blob, mime: string, name: string) => void;
  remove: (id: string) => void;
}

/** One list for Drive's Live panel, Overwatch and the drive summary. */
export const useClipsStore = create<ClipsState>((set, get) => ({
  clips: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const stored = await listClips();
    set({ clips: stored.map((c) => ({ ...c, url: URL.createObjectURL(c.blob) })), loaded: true });
  },
  add: (blob, mime, name) => {
    const clip: Clip = { id: `clip/${Date.now()}`, at: Date.now(), name, mime, blob };
    void saveClip(clip);
    set({ clips: [{ ...clip, url: URL.createObjectURL(blob) }, ...get().clips].slice(0, KEEP) });
  },
  remove: (id) => {
    const gone = get().clips.find((c) => c.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    void deleteClip(id);
    set({ clips: get().clips.filter((c) => c.id !== id) });
  },
}));

/** Every clip in one .zip download (built on demand, then released). */
export async function downloadClipsZip(clips: Clip[], label: string) {
  const zip = await makeZip(clips.map((c) => ({ name: clipFileName(c), blob: c.blob, at: c.at })));
  downloadBlob(zip, `${label}.zip`);
}
