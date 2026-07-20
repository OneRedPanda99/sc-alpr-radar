import type { CSSProperties } from "react";

export type IconName = "drive" | "route" | "settings" | "bearing";

const PATHS: Record<IconName, JSX.Element> = {
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
