import { useEffect, useRef, useState } from "react";
import type { LatLng } from "@/types";
import { geocode } from "@/services/routing";
import { parseCoordinates } from "@/services/geo";
import { loadRecents, rememberPlace, type RecentPlace } from "@/services/trips";
import { Icon } from "@/components/Icon";

type Place = { label: string; point: LatLng };

interface PlaceInputProps {
  label: string;
  point: LatLng | null;
  placeholder: string;
  /** Biases search results toward here (usually your GPS position). */
  near: LatLng | null;
  /** Offer "Use my location" (start fields). */
  allowGps?: boolean;
  onPick: (place: Place) => void;
  /** Typing clears the picked point; the parent decides what that means. */
  onEdit: (text: string) => void;
  onGps?: () => void;
  onPickOnMap?: () => void;
  autoFocus?: boolean;
}

/**
 * Address field with search-as-you-type. The old flow was type → tap Search →
 * tap a result, which is three deliberate actions for something every maps app
 * does in one. Results appear after a short pause; Enter takes the top one.
 */
export function PlaceInput({
  label,
  point,
  placeholder,
  near,
  allowGps,
  onPick,
  onEdit,
  onGps,
  onPickOnMap,
  autoFocus,
}: PlaceInputProps) {
  const [query, setQuery] = useState(label);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [recents, setRecents] = useState<RecentPlace[]>([]);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Follow outside changes (GPS, map pin, swap, reorder).
  useEffect(() => setQuery(label), [label]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [autoFocus]);

  useEffect(() => {
    const q = query.trim();
    if (!open || point || q.length < 3) {
      setResults([]);
      setSearching(false);
      setEmpty(false);
      return;
    }
    const id = ++seq.current;
    // Typed or pasted coordinates resolve instantly, no network needed.
    const coords = parseCoordinates(q);
    if (coords) {
      setResults([
        { label: `${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)}`, point: coords },
      ]);
      setSearching(false);
      setEmpty(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await geocode(q, near);
        if (id !== seq.current) return;
        setResults(r.slice(0, 6));
        setEmpty(r.length === 0);
      } catch {
        if (id === seq.current) setEmpty(true);
      } finally {
        if (id === seq.current) setSearching(false);
      }
    }, 380);
    return () => clearTimeout(t);
  }, [query, open, point, near]);

  const pick = (p: Place) => {
    rememberPlace(p);
    setOpen(false);
    setResults([]);
    onPick(p);
    inputRef.current?.blur();
  };

  const showSuggestions = open && !point && query.trim().length < 3;

  return (
    <div className="place-input">
      <div className={`place-input-box ${point ? "set" : ""}`}>
        <input
          ref={inputRef}
          className="search-input"
          placeholder={placeholder}
          value={query}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          onFocus={(e) => {
            setOpen(true);
            setRecents(loadRecents());
            // Selecting the whole label makes replacing a set place one tap.
            if (point) e.currentTarget.select();
          }}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            onEdit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) {
              e.preventDefault();
              pick(results[0]);
            } else if (e.key === "Escape") {
              inputRef.current?.blur();
            }
          }}
        />
        {searching && <span className="spinner sm place-input-spin" aria-label="Searching" />}
        {query && !searching && (
          <button
            type="button"
            className="place-clear"
            aria-label="Clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery("");
              onEdit("");
              inputRef.current?.focus();
            }}
          >
            ✕
          </button>
        )}
      </div>

      {open && (showSuggestions || results.length > 0 || empty) && (
        // mousedown is cancelled so tapping a result doesn't blur (and close)
        // the list before the click lands.
        <ul className="results" onMouseDown={(e) => e.preventDefault()}>
          {showSuggestions && allowGps && onGps && (
            <li>
              <button type="button" className="result-special" onClick={() => { setOpen(false); onGps(); }}>
                <Icon name="locate" /> Use my location
              </button>
            </li>
          )}
          {showSuggestions && onPickOnMap && (
            <li>
              <button type="button" className="result-special" onClick={() => { setOpen(false); onPickOnMap(); }}>
                <Icon name="pin" /> Choose on map
              </button>
            </li>
          )}
          {showSuggestions &&
            recents.slice(0, 5).map((r) => (
              <li key={`recent-${r.label}`}>
                <button type="button" onClick={() => pick(r)}>
                  <span className="result-recent">Recent</span> {r.label}
                </button>
              </li>
            ))}
          {results.map((r, i) => (
            <li key={`${r.label}-${i}`}>
              <button
                type="button"
                className={parseCoordinates(query) ? "result-special" : ""}
                onClick={() => pick(r)}
              >
                {parseCoordinates(query) && <Icon name="pin" />}
                {parseCoordinates(query) ? `Coordinates ${r.label}` : r.label}
              </button>
            </li>
          ))}
          {empty && !results.length && (
            <li className="result-empty">
              No matches. Try a street number, street and city.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
