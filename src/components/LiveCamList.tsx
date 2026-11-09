import type { Camera } from "@/types";
import { formatDistance } from "@/services/routing";

export interface LiveCamItem {
  c: Camera;
  d: number;
  /** False when the camera is behind you on the drive. */
  ahead?: boolean;
}

/** Nearby live cameras to switch between; shared by Drive and Overwatch. */
export function LiveCamList({
  items,
  selectedId,
  onPick,
}: {
  items: LiveCamItem[];
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <ul className="feed-list">
      {items.map(({ c, d, ahead }) => (
        <li key={c.id}>
          <button
            type="button"
            className={selectedId === c.id ? "on" : ""}
            aria-pressed={selectedId === c.id}
            onClick={() => onPick(c.id)}
            title={c.name}
          >
            <span className="feed-list-name">{c.name ?? "SCDOT camera"}</span>
            <span className="feed-list-dist">
              {formatDistance(d)}
              {ahead === false && " behind"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
