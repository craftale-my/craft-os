/** Parsed geofence values, shaped to drop straight onto a `branches` row.
 *
 *  All three columns are nullable and must stay that way: ClockModal.tsx:111
 *  skips the distance check entirely when a branch has no coordinates, which
 *  is how the two pre-existing branches still work. */
export type GeofenceParseResult =
  | { ok: true; latitude: number | null; longitude: number | null; radius_meters: number | null }
  | { ok: false; error: string }

/** Google Maps copies a location as "3.2173718,101.6406565" — one string. */
const LAT_LNG_PAIR = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/

/** Hard floor on the radius. A branch saved with 1m would reject every
 *  clock-in at that branch, and the staff-facing message ("You are 12m away
 *  from X") gives nobody a reason to suspect the setting. */
const MIN_RADIUS_M = 20
const MAX_RADIUS_M = 2000

export function parseBranchGeofence(lat: string, lng: string, radius: string): GeofenceParseResult {
  let latRaw = lat.trim()
  let lngRaw = lng.trim()
  const radiusRaw = radius.trim()

  // Accept a pasted "lat,lng" pair in the latitude field rather than rejecting
  // the exact thing someone copying from Google Maps will paste first.
  const pair = LAT_LNG_PAIR.exec(latRaw)
  if (pair && !lngRaw) {
    latRaw = pair[1]
    lngRaw = pair[2]
  }

  if (!latRaw && !lngRaw) {
    if (radiusRaw) {
      return { ok: false, error: 'Set a latitude and longitude before setting a radius.' }
    }
    return { ok: true, latitude: null, longitude: null, radius_meters: null }
  }

  if (!latRaw || !lngRaw) {
    return { ok: false, error: 'Enter both latitude and longitude, or leave both blank.' }
  }

  const latNum = Number(latRaw)
  const lngNum = Number(lngRaw)
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, error: 'Latitude and longitude must be numbers.' }
  }
  if (latNum < -90 || latNum > 90) {
    return { ok: false, error: 'Latitude must be between -90 and 90.' }
  }
  if (lngNum < -180 || lngNum > 180) {
    return { ok: false, error: 'Longitude must be between -180 and 180.' }
  }

  if (!radiusRaw) {
    // Coordinates without a radius: ClockModal falls back to 100m (`:119`).
    return { ok: true, latitude: latNum, longitude: lngNum, radius_meters: null }
  }

  const radiusNum = Number(radiusRaw)
  if (!Number.isInteger(radiusNum) || radiusNum < MIN_RADIUS_M || radiusNum > MAX_RADIUS_M) {
    return {
      ok: false,
      error: `Radius must be a whole number between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} meters.`,
    }
  }

  return { ok: true, latitude: latNum, longitude: lngNum, radius_meters: radiusNum }
}
