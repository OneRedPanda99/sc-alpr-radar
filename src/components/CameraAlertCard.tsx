import { useState } from "react";
import type { Camera } from "@/types";
import { brandImage, formatFacing, KIND_LABELS } from "@/services/brand";
import { metersToFeet } from "@/services/geo";
import { communitySubmitUrl } from "@/services/community";

function subtitle(camera: Camera): string {
  return camera.kind === "alpr" ? camera.brand : KIND_LABELS[camera.kind];
}

function cardTitle(camera: Camera): string {
  if (camera.name) return camera.name;
  if (camera.operator) return camera.operator;
  return camera.kind === "alpr" ? `${camera.brand} ALPR` : KIND_LABELS[camera.kind];
}

const COMPASS: { label: string; deg: number | null }[] = [
  { label: "360°", deg: null },
  { label: "N", deg: 0 },
  { label: "NE", deg: 45 },
  { label: "E", deg: 90 },
  { label: "SE", deg: 135 },
  { label: "S", deg: 180 },
  { label: "SW", deg: 225 },
  { label: "W", deg: 270 },
  { label: "NW", deg: 315 },
];

/** Facing picker: null = omni / 360°, else 0–359 degrees. */
export function FacingPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (deg: number | null) => void;
}) {
  return (
    <div className="facing-picker">
      <div className="facing-label">Facing</div>
      <div className="facing-compass">
        {COMPASS.map((c) => (
          <button
            key={c.label}
            type="button"
            className={value === c.deg ? "on" : ""}
            onClick={() => onChange(c.deg)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <label className="facing-deg-row">
        <span>Degrees</span>
        <input
          type="number"
          min={0}
          max={359}
          inputMode="numeric"
          placeholder="0–359"
          value={value ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(null);
              return;
            }
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            onChange(((Math.round(n) % 360) + 360) % 360);
          }}
        />
      </label>
    </div>
  );
}

interface Props {
  camera: Camera;
  distanceMeters: number;
  ahead: boolean;
  muted: boolean;
  urgency: "cool" | "warm" | "hot";
}

export function CameraAlertCard({
  camera,
  distanceMeters,
  ahead,
  muted,
  urgency,
}: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const feet = Math.round(metersToFeet(distanceMeters));
  const photo = !imgFailed && (camera.imageUrl || brandImage(camera.brand));
  const title = cardTitle(camera);

  return (
    <div className={`alert-card ${urgency}`}>
      <div className="alert-card-media">
        {photo ? (
          <img
            src={photo}
            alt={camera.brand}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="alert-card-fallback">{camera.brand[0]}</div>
        )}
      </div>

      <div className="alert-card-body">
        <div className="alert-card-top">
          <div>
            <div className="alert-card-title">{title}</div>
            <div className="alert-card-brand">{subtitle(camera)}</div>
          </div>
          <div className="alert-card-dist">
            {feet}
            <span>ft</span>
          </div>
        </div>

        <div className="alert-card-meta">
          <div>
            <span className="meta-label">Facing</span>
            <span>{formatFacing(camera.directions, camera.omni)}</span>
          </div>
          <div>
            <span className="meta-label">Used for</span>
            <span>{camera.purpose}</span>
          </div>
          {camera.operator && camera.operator !== camera.name && (
            <div>
              <span className="meta-label">Operator</span>
              <span>{camera.operator}</span>
            </div>
          )}
        </div>

        <div className="alert-card-foot">
          <span className={`pill ${ahead ? "pill-ahead" : ""}`}>
            {ahead ? "Ahead" : "Nearby"}
          </span>
          {muted && <span className="pill">Muted</span>}
          {camera.zone && <span className="pill">{camera.zone}</span>}
        </div>
      </div>
    </div>
  );
}

interface DetailProps {
  camera: Camera;
  distanceMeters?: number | null;
  onClose: () => void;
  onDelete?: (id: string) => void;
  onUpdateFacing?: (
    id: string,
    facing: { omni: boolean; degrees: number | null },
  ) => void;
}

export function CameraDetailCard({
  camera,
  distanceMeters,
  onClose,
  onDelete,
  onUpdateFacing,
}: DetailProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const photo = !imgFailed && (camera.imageUrl || brandImage(camera.brand));
  const title = cardTitle(camera);
  const feet =
    distanceMeters != null ? Math.round(metersToFeet(distanceMeters)) : null;
  const facingValue = camera.omni
    ? null
    : (camera.directions[0] ?? null);

  return (
    <div className="detail-card">
      <button className="detail-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="detail-media">
        {photo ? (
          <img src={photo} alt={camera.brand} onError={() => setImgFailed(true)} />
        ) : (
          <div className="alert-card-fallback">{camera.brand[0]}</div>
        )}
      </div>
      <div className="detail-body">
        <div className="alert-card-title">{title}</div>
        <div className="alert-card-brand">{subtitle(camera)}</div>
        <div className="detail-grid">
          <div>
            <span className="meta-label">Facing</span>
            <span>{formatFacing(camera.directions, camera.omni)}</span>
          </div>
          <div>
            <span className="meta-label">Used for</span>
            <span>{camera.purpose}</span>
          </div>
          {camera.operator && camera.operator !== camera.name && (
            <div>
              <span className="meta-label">Operator</span>
              <span>{camera.operator}</span>
            </div>
          )}
          {camera.zone && (
            <div>
              <span className="meta-label">Zone</span>
              <span>{camera.zone}</span>
            </div>
          )}
          {feet != null && (
            <div>
              <span className="meta-label">Distance</span>
              <span>{feet} ft</span>
            </div>
          )}
        </div>
        {camera.custom && onUpdateFacing && (
          <FacingPicker
            value={facingValue}
            onChange={(deg) =>
              onUpdateFacing(camera.id, {
                omni: deg == null,
                degrees: deg,
              })
            }
          />
        )}
        {camera.custom && (
          <div className="detail-actions">
            <a
              className="detail-share"
              href={communitySubmitUrl(camera)}
              target="_blank"
              rel="noreferrer"
            >
              Share with everyone
            </a>
            {onDelete && (
              <button
                className="detail-delete"
                onClick={() => onDelete(camera.id)}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function AllClearBanner() {
  return (
    <div className="alert-card clear">
      <div className="alert-card-body">
        <div className="alert-card-title">All clear</div>
        <div className="alert-card-brand">No cameras in alert range</div>
      </div>
    </div>
  );
}
