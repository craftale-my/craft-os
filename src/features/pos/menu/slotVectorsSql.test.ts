import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vectors from './slotVectors.json'

describe('the SQL verify script carries the very same time-slot vectors', () => {
  it('matches slotVectors.json exactly', () => {
    const sql = readFileSync(new URL('../../../../supabase/migration-2026-10-24-pos-slots-photos-verify.sql', import.meta.url), 'utf8')
    const m = sql.match(/\$vectors\$([\s\S]*?)\$vectors\$/)
    expect(m).not.toBeNull()
    expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual(vectors)
  })
})
