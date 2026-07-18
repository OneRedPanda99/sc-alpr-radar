import { useState } from "react";
import type { Camera } from "@/types";
import { brandImage, formatFacing } from "@/services/brand";
import { metersToFeet } from "@/services/geo";

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
  const title =
    camera.name ||
    camera.operator ||
    `${camera.brand} ALPR`;

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
            <div className="alert-card-brand">{camera.brand}</div>
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
}

export function CameraDetailCard({ camera, distanceMeters, onClose }: DetailProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const photo = !imgFailed && (camera.imageUrl || brandImage(camera.brand));
  const title = camera.name || camera.operator || `${camera.brand} ALPR`;
  const feet =
    distanceMeters != null ? Math.round(metersToFeet(distanceMeters)) : null;

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
        <div className="alert-card-brand">{camera.brand}</div>
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
