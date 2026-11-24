import { describe, expect, it } from 'vitest'
import { AVATARS, avatarEmoji, cleanName, loadGuest, newGuest, randomAvatar, saveGuest, type GuestStorage } from './qrGuest'

const fakeStorage = (): GuestStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}
const ID = '11111111-2222-4333-8444-555555555555'

describe('cleanName', () => {
  it('trims, drops control characters and cuts at 20', () => {
    expect(cleanName('  Mei \n')).toBe('Mei')
    expect(cleanName('a'.repeat(30))).toBe('a'.repeat(20))
    expect(cleanName('Tab\there')).toBe('Tabhere')
  })
  it('an empty name is Guest', () => {
    expect(cleanName('')).toBe('Guest')
    expect(cleanName('   ')).toBe('Guest')
  })
})

describe('avatars', () => {
  it('has eight, keyed a1 to a8', () => {
    expect(AVATARS.map((a) => a.key)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
  })
  it('gives the emoji of a key, nothing for an unknown one', () => {
    expect(avatarEmoji('a1')).toBe(AVATARS[0].emoji)
    expect(avatarEmoji('zz')).toBe('')
    expect(avatarEmoji(null)).toBe('')
  })
  it('picks a random avatar from the list', () => {
    expect(randomAvatar(() => 0)).toBe('a1')
    expect(randomAvatar(() => 0.999)).toBe('a8')
  })
})

describe('loadGuest / saveGuest', () => {
  it('round-trips per table token', () => {
    const s = fakeStorage()
    saveGuest('tokA', newGuest('Mei', 'a3', ID), s)
    expect(loadGuest('tokA', s)).toEqual({ id: ID, name: 'Mei', avatar: 'a3' })
    expect(loadGuest('tokB', s)).toBeNull()
  })
  it('ignores a stored value that is not a guest', () => {
    const s = fakeStorage()
    s.data.set('qr-guest-tokA', '{"id":"nope","name":"x","avatar":"a1"}')
    expect(loadGuest('tokA', s)).toBeNull()
    s.data.set('qr-guest-tokA', 'not json')
    expect(loadGuest('tokA', s)).toBeNull()
  })
  it('keeps the guest for the visit when storage is unavailable or throws', () => {
    saveGuest('tokNoStore', newGuest('Ann', 'a2', ID), null)
    expect(loadGuest('tokNoStore', null)).toEqual({ id: ID, name: 'Ann', avatar: 'a2' })
    const broken: GuestStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    saveGuest('tokBroken', newGuest('Bo', 'a1', ID), broken)
    expect(loadGuest('tokBroken', broken)).toEqual({ id: ID, name: 'Bo', avatar: 'a1' })
  })
  it('newGuest cleans the name and falls back to a1 for an unknown avatar', () => {
    expect(newGuest('  ', 'zz', ID)).toEqual({ id: ID, name: 'Guest', avatar: 'a1' })
  })
})
