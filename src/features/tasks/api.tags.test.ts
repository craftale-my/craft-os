// upsertTag 的「撞 slug 时怎么办」是资料库语义,不是 UI 行为,所以必须在这一层测。
//
// TaskDetailModal.tags.test.tsx 整包 mock 掉 ./api,它看到的 upsertTag 是测试自己
// 写的假表——那张假表当然是先到先得,所以不论 api.ts 里怎么写,那个测试都是绿的。
// 它能证明的只有「弹窗有把 upsertTag 回传的 id 拿去 attachTag」。真正会覆盖既有
// name / created_by 的那行 Supabase 呼叫,在它的视野之外。
//
// 这里反过来:让 ./api 跑真的,只把 supabase client 换成假的,而且假的那一份要
// 忠实照抄真实语义 ——
//   · .from('tags').upsert(values, { onConflict }) 送出的一律是
//     `on conflict (<onConflict>) do update set <每个给定栏位> = excluded.<栏位>`;
//     supabase-js 没有任何语法能表达「冲突时保留既有值」。
//   · rpc('upsert_tag', …) 对应 migration 里的
//     `on conflict (slug) do update set name = tags.name returning *`,
//     写回既有值,只为了让 RETURNING 有列可回。
// 两条路都接到同一张假 tags 表上,所以断言看的是「资料列最后长什么样」,
// 而不是某个函式有没有被呼叫。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  interface TagRow {
    id: string
    slug: string
    name: string
    color: string
    created_by: string | null
  }

  const tags: TagRow[] = []
  let seq = 0

  /** 把一列裁成呼叫端 .select() 指定的栏位,跟 PostgREST 一样。 */
  function project(row: TagRow, cols: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const c of cols.split(',').map(s => s.trim())) out[c] = row[c as keyof TagRow]
    return out
  }

  /** `.select(cols).single()` 的尾巴。零列时比照 PostgREST 回 PGRST116 error。 */
  function returning(row: TagRow | null) {
    let cols = '*'
    const t = {
      select(c: string) { cols = c; return t },
      async single() {
        if (!row) {
          return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }
        }
        return { data: cols === '*' ? { ...row } : project(row, cols), error: null }
      },
    }
    return t
  }

  const supabase = {
    from(table: string) {
      if (table !== 'tags') throw new Error(`unexpected table in this test: ${table}`)
      return {
        upsert(values: Record<string, unknown>, opts: { onConflict: string }) {
          const key = values[opts.onConflict]
          const existing = tags.find(t => t[opts.onConflict as keyof TagRow] === key)
          if (existing) {
            // DO UPDATE SET <每个给定栏位> = EXCLUDED.<栏位> —— 后来者整包盖上去。
            Object.assign(existing, values)
            return returning(existing)
          }
          const created = { id: `tag-${++seq}`, color: '#8B7355', ...values } as TagRow
          tags.push(created)
          return returning(created)
        },
      }
    },

    rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== 'upsert_tag') throw new Error(`unexpected rpc in this test: ${fn}`)
      const existing = tags.find(t => t.slug === args.p_slug)
      // DO UPDATE SET name = tags.name —— 写回既有值,name / created_by 都不动。
      if (existing) return returning(existing)
      const created: TagRow = {
        id: `tag-${++seq}`,
        slug: String(args.p_slug),
        name: String(args.p_name),
        color: '#8B7355',
        created_by: (args.p_created_by as string | null) ?? null,
      }
      tags.push(created)
      return returning(created)
    },
  }

  return { tags, supabase, reset() { tags.length = 0; seq = 0 } }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: h.supabase }))

const { upsertTag } = await import('./api')

beforeEach(() => h.reset())

describe('upsertTag:slug 去重要留着,先写入者的 name 与 created_by 不能被后来者盖掉', () => {
  it('reuses the existing row when the same tag is retyped with different casing', async () => {
    const first  = await upsertTag('Urgent', 'staff-1')
    const second = await upsertTag('urgent', 'staff-2')

    expect(second.id).toBe(first.id)
    expect(h.tags).toHaveLength(1)
  })

  it('leaves the stored display name as the first writer typed it', async () => {
    await upsertTag('Urgent', 'staff-1')
    await upsertTag('urgent', 'staff-2')

    // 这一列挂在全板的任务上。改掉它,别人的卡片会无声换字。
    expect(h.tags[0].name).toBe('Urgent')
  })

  it('does not reassign created_by to whoever retyped the tag', async () => {
    await upsertTag('Urgent', 'staff-1')
    await upsertTag('urgent', 'staff-2')

    expect(h.tags[0].created_by).toBe('staff-1')
  })

  it("hands the first writer's display name back to the caller", async () => {
    await upsertTag('Urgent', 'staff-1')
    const second = await upsertTag('  URGENT  ', 'staff-2')

    expect(second.name).toBe('Urgent')
    expect(second.slug).toBe('urgent')
  })

  it('still creates a row for a genuinely new slug', async () => {
    await upsertTag('Urgent', 'staff-1')
    await upsertTag('Beans', 'staff-2')

    expect(h.tags.map(t => t.slug)).toEqual(['urgent', 'beans'])
    expect(h.tags.map(t => t.created_by)).toEqual(['staff-1', 'staff-2'])
  })

  it('rejects an empty tag name without touching the table', async () => {
    await expect(upsertTag('   ', 'staff-1')).rejects.toThrow(/cannot be empty/i)

    expect(h.tags).toHaveLength(0)
  })
})
