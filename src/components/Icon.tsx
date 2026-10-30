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
  | "search";

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
  pin: (
    <>
      <path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21Z" {...stroke} />
      <circle cx="12" cy="9.8" r="2.3" {...stroke} />
    </>
  ),
  // Eye / overwatch
  watch: (
    <>
      <path
        d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </>
  ),
  // Steering-wheel / drive
  drive: (
    <>
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
      <path
        d="M12 12 L12 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 3.5 L16 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  // Route — pin + dashed path
  route: (
    <>
      <path
        d="M5 20 C 5 13, 12 13, 12 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="0.5 3"
      />
      <path
        d="M12 7.5 C 12 5.3, 14 4.2, 15.6 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M19 5.2 a 3.2 3.2 0 0 1 0 6.4 a 3.2 3.2 0 0 1 -2.3 -1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="19" cy="8.4" r="1.1" fill="currentColor" />
    </>
  ),
  // Settings — gear
  settings: (
    <>
      <circle
        cx="12"
        cy="12"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 2.5 v 2.6 M12 18.9 v 2.6 M21.5 12 h -2.6 M5.1 12 H 2.5 M18.7 5.3 l -1.8 1.8 M7.1 16.9 l -1.8 1.8 M18.7 18.7 l -1.8 -1.8 M7.1 7.1 L 5.3 5.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
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
