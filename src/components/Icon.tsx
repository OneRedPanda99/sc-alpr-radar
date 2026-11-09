import type { CSSProperties } from "react";

export type IconName =
  | "drive"
  | "route"
  | "watch"
  | "settings"
  | "bearing"
  | "locate"
  | "swap"
  | "plus"
  | "layers"
  | "flag"
  | "video"
  | "trash"
  | "up"
  | "down"
  | "pin"
  | "search"
  | "sound"
  | "mute"
  | "note"
  | "check"
  | "shield";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PATHS: Record<IconName, JSX.Element> = {
  locate: (
    <>
      <circle cx="12" cy="12" r="6.5" {...stroke} />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" {...stroke} />
    </>
  ),
  swap: <path d="M7 4v15M7 19l-3-3M7 19l3-3M17 20V5M17 5l-3 3M17 5l3 3" {...stroke} />,
  plus: <path d="M12 5v14M5 12h14" {...stroke} />,
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" {...stroke} />
      <path d="m3 12.5 9 5 9-5M3 16.5l9 5 9-5" {...stroke} />
    </>
  ),
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" {...stroke} />,
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.5" {...stroke} />
      <path d="m16 10.5 5-3v9l-5-3" {...stroke} />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" {...stroke} />,
  up: <path d="m6 15 6-6 6 6" {...stroke} />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" {...stroke} />
      <path d="m15.5 15.5 5 5" {...stroke} />
    </>
  ),
  down: <path d="m6 9 6 6 6-6" {...stroke} />,
  sound: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" {...stroke} />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" {...stroke} />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" {...stroke} />
      <path d="m16 9.5 5 5M21 9.5l-5 5" {...stroke} />
    </>
  ),
  note: <path d="M5 4h10l4 4v12H5zM15 4v4h4M8.5 12h7M8.5 16h5" {...stroke} />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" {...stroke} />,
  // Police: a badge shield with a star.
  shield: (
    <>
      <path d="M12 3 19 6v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6Z" {...stroke} />
      <path d="m12 8.6 1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3Z" fill="currentColor" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21Z" {...stroke} />
      <circle cx="12" cy="9.8" r="2.3" {...stroke} />
    </>
  ),
  // Tab bar: all line icons on the same 1.9 stroke as the rest of the set.
  // Drive: navigation arrow, the universal "you, moving" mark.
  drive: <path d="M12 3 19.5 20 12 16.2 4.5 20Z" {...stroke} />,
  // Plan: folded map with a pin on it.
  route: (
    <>
      <path d="M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2Z" {...stroke} />
      <path d="M9 4.5v13M15 6.5v4" {...stroke} />
      <path d="M17.5 17.8s-2.6-2.4-2.6-4.3a2.6 2.6 0 0 1 5.2 0c0 1.9-2.6 4.3-2.6 4.3Z" {...stroke} />
    </>
  ),
  // Overwatch: video camera.
  watch: (
    <>
      <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" {...stroke} />
      <path d="m15.5 10.5 6-3.5v10l-6-3.5" {...stroke} />
      <circle cx="6.5" cy="10" r="1.1" fill="currentColor" />
    </>
  ),
  // Settings: sliders.
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h3.5M11.5 12H20" {...stroke} />
      <circle cx="15" cy="7" r="2" {...stroke} />
      <circle cx="9" cy="17" r="2" {...stroke} />
      <circle cx="9.5" cy="12" r="2" {...stroke} />
    </>
  ),
  // Bearing arrow
  bearing: <path d="M12 3 L19 20 L12 16 L5 20 Z" fill="currentColor" />,
};

interface IconProps {
  name: IconName;
  style?: CSSProperties;
}

export function Icon({ name, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
