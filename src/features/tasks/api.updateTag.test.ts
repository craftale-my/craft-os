// updateTag() 的「改名一定要跟着重算 slug」是结构性的:呼叫端的 patch 型别
// 根本没有 slug 这一栏,想传都传不了。这里从 supabase client 这一层测,
// 断言的是「真的送去 Postgres 的那笔资料长什么样」,而不是某个函式有没有
// 被呼叫——跟 api.tags.test.ts 测 upsertTag 用的是同一个理由:mock ./api
// 本身只能证明呼叫端把参数转发出去了,证明不了 api.ts 里到底组出了什么 SQL。
//
// 撞名(改到一个已经有别人在用的 slug)在真的 Postgres 上是 tags.slug 的
// unique index 炸出 23505。这里的假 supabase client 照抄这个形状:同一张
// 假表里若已经有另一笔 slug 相同,update 就回传 { data: null, error: { code:
// '23505', ... } },逼 updateTag() 把它接住、换成一句人看得懂的错误,而不是
// 让 Postgres 的原始讯息("duplicate key value violates unique constraint …")
// 直接冒到使用者面前。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  interface TagRow {
    id: string
    slug: string
    name: string
    color: string
  }

  const tags: TagRow[] = []

  /** 模拟 `.from('tags').update(patch).eq(col, val).select()`。
   *  跟真正的 Postgres 一样:撞到别人正在用的 slug 就回 23505,不吐资料列。 */
  const supabase = {
    from(table: string) {
      if (table !== 'tags') throw new Error(`unexpected table in this test: ${table}`)
      return {
        update(patch: Partial<TagRow>) {
          return {
            eq(col: keyof TagRow, val: string) {
              return {
                async select() {
                  const row = tags.find(t => t[col] === val)
                  if (!row) return { data: [], error: null }

                  if (patch.slug !== undefined) {
                    const clash = tags.find(t => t.id !== row.id && t.slug === patch.slug)
                    if (clash) {
                      return {
                        data: null,
                        error: {
                          code: '23505',
                          message: 'duplicate key value violates unique constraint "tags_slug_key"',
                        },
                      }
                    }
                  }

                  Object.assign(row, patch)
                  return { data: [{ ...row }], error: null }
                },
              }
            },
          }
        },
      }
    },
  }

  return { tags, supabase, reset() { tags.length = 0 } }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const { updateTag } = await import('./api')

beforeEach(() => {
  h.reset()
  h.tags.push({ id: 'tag-1', slug: 'urgnet',   name: 'Urgnet',   color: '#8B7355' })
  h.tags.push({ id: 'tag-2', slug: 'critical', name: 'Critical', color: '#C4813A' })
})

describe('updateTag:改名一定要跟着重算 slug,结构上不可能只改一个', () => {
  it('recomputes the slug from the new name', async () => {
    const res = await updateTag('tag-1', { name: 'Urgent' })

    expect(res.ok).toBe(true)
    expect(h.tags[0]).toMatchObject({ id: 'tag-1', name: 'Urgent', slug: 'urgent' })
  })

  it('normalizes the display name too — trims and collapses whitespace', async () => {
    const res = await updateTag('tag-1', { name: '  Ur  gent  ' })

    expect(res.ok).toBe(true)
    expect(h.tags[0]).toMatchObject({ name: 'Ur gent', slug: 'ur gent' })
  })

  it('leaves slug and name untouched when only recolouring', async () => {
    const res = await updateTag('tag-1', { color: '#FF0000' })

    expect(res.ok).toBe(true)
    expect(h.tags[0]).toMatchObject({ slug: 'urgnet', name: 'Urgnet', color: '#FF0000' })
  })

  it('rejects an empty name without touching the row', async () => {
    const res = await updateTag('tag-1', { name: '   ' })

    expect(res.ok).toBe(false)
    expect(h.tags[0]).toMatchObject({ slug: 'urgnet', name: 'Urgnet' })
  })

  it('allows renaming to a different casing of its own current name (no self-collision)', async () => {
    const res = await updateTag('tag-1', { name: 'URGNET' })

    expect(res.ok).toBe(true)
    expect(h.tags[0]).toMatchObject({ name: 'URGNET', slug: 'urgnet' })
  })
})

describe('updateTag:改名撞到别人正在用的 slug', () => {
  it('fails with a readable reason instead of the raw Postgres constraint message', async () => {
    const res = await updateTag('tag-1', { name: 'Critical' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toMatch(/already exists/i)
    expect(res.reason).not.toMatch(/constraint|23505|duplicate key/i)
  })

  it('leaves both rows exactly as they were — no partial write, no merge', async () => {
    await updateTag('tag-1', { name: 'Critical' })

    expect(h.tags[0]).toMatchObject({ id: 'tag-1', slug: 'urgnet',   name: 'Urgnet' })
    expect(h.tags[1]).toMatchObject({ id: 'tag-2', slug: 'critical', name: 'Critical' })
  })
})
