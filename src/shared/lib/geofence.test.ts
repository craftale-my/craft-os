import { describe, it, expect } from 'vitest'
import { parseBranchGeofence } from './geofence'

describe('parseBranchGeofence', () => {
  it('all three blank: clears the geofence (clock-in from anywhere)', () => {
    expect(parseBranchGeofence('', '', '')).toEqual({
      ok: true, latitude: null, longitude: null, radius_meters: null,
    })
  })

  it('whitespace counts as blank', () => {
    expect(parseBranchGeofence('  ', '\t', ' ')).toEqual({
      ok: true, latitude: null, longitude: null, radius_meters: null,
    })
  })

  it('accepts Kepong normal values', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '100')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: 100,
    })
  })

  it('splits a "lat,lng" pair pasted into the latitude field alone', () => {
    expect(parseBranchGeofence('3.2173718,101.6406565', '', '100')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: 100,
    })
  })

  it('tolerates spaces around a pasted pair', () => {
    expect(parseBranchGeofence(' 3.2173718, 101.6406565 ', '', '')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: null,
    })
  })

  it('does not split a pasted pair when longitude is already filled', () => {
    const res = parseBranchGeofence('3.2173718,101.6406565', '101.6406565', '100')
    expect(res).toEqual({ ok: false, error: 'Latitude and longitude must be numbers.' })
  })

  it('rejects latitude without longitude', () => {
    expect(parseBranchGeofence('3.2173718', '', '')).toEqual({
      ok: false, error: 'Enter both latitude and longitude, or leave both blank.',
    })
  })

  it('rejects longitude without latitude', () => {
    expect(parseBranchGeofence('', '101.6406565', '')).toEqual({
      ok: false, error: 'Enter both latitude and longitude, or leave both blank.',
    })
  })

  it('rejects a radius with no coordinates to centre it on', () => {
    expect(parseBranchGeofence('', '', '100')).toEqual({
      ok: false, error: 'Set a latitude and longitude before setting a radius.',
    })
  })

  it('rejects non-numeric coordinates', () => {
    expect(parseBranchGeofence('three', '101.6406565', '')).toEqual({
      ok: false, error: 'Latitude and longitude must be numbers.',
    })
  })

  it('rejects latitude out of range', () => {
    expect(parseBranchGeofence('91', '101.6406565', '')).toEqual({
      ok: false, error: 'Latitude must be between -90 and 90.',
    })
  })

  it('rejects longitude out of range', () => {
    expect(parseBranchGeofence('3.2173718', '181', '')).toEqual({
      ok: false, error: 'Longitude must be between -180 and 180.',
    })
  })

  it('accepts negative coordinates (southern/western hemispheres)', () => {
    expect(parseBranchGeofence('-33.8688', '-70.6693', '100')).toEqual({
      ok: true, latitude: -33.8688, longitude: -70.6693, radius_meters: 100,
    })
  })

  it('blank radius with coordinates set leaves the app default to apply', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: null,
    })
  })

  it('rejects a radius below 20m — it would lock everyone out', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '1')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })

  it('rejects a radius above 2000m', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '5000')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })

  it('rejects a fractional radius', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '100.5')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })

  it('rejects a non-numeric radius', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', 'wide')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })
})
