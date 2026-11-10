import { useEffect, useState } from "react";
import {
  clipFileName,
  downloadBlob,
  downloadClipsZip,
  useClipsStore,
} from "@/services/clips";

/**
 * Your recorded passes: play, save one, delete one, or download them all as
 * a single .zip. `since` limits it to one drive.
 */
export function ClipLibrary({ title = "Your passes", since }: { title?: string; since?: number }) {
  const { clips: all, load, remove } = useClipsStore();
  const [zipping, setZipping] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  const clips = since ? all.filter((c) => c.at >= since) : all;
  if (!clips.length) return null;

  const zipAll = async () => {
    setZipping(true);
    try {
      const day = new Date(clips[0].at).toISOString().slice(0, 10);
      await downloadClipsZip(clips, `passes-${day}`);
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="clips">
      <div className="clips-head">
        <h4>
          {title} ({clips.length})
        </h4>
        <button type="button" className="ghost-btn" onClick={zipAll} disabled={zipping}>
          {zipping ? "Zipping…" : "Download all"}
        </button>
      </div>
      <ul>
        {clips.map((c) => (
          <li key={c.id}>
            <video src={c.url} controls muted playsInline preload="metadata" />
            <div className="clip-meta">
              <span>
                {c.name} · {new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              <button type="button" className="text-btn" onClick={() => downloadBlob(c.blob, clipFileName(c))}>
                Save
              </button>
              <button type="button" className="text-btn" onClick={() => remove(c.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
