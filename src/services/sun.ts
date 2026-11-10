/**
 * Where the sun is, so the map can go dark at night without asking. This is
 * the standard low-precision solar position (good to a fraction of a degree),
 * plenty for "is it dark out yet".
 */
const RAD = Math.PI / 180;

/** Sun's height above the horizon in degrees at a place and time. */
export function sunElevation(lat: number, lon: number, date = new Date()): number {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const alt = Math.asin(
    Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha),
  );
  return alt / RAD;
}

/** Dark enough for headlights: a little after sunset until a little before sunrise. */
export function isDarkOut(lat: number, lon: number, date = new Date()): boolean {
  return sunElevation(lat, lon, date) < -3;
}
