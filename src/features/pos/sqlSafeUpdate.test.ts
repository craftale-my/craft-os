import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

// Supabase's API runs every request under pg-safeupdate: a DELETE or UPDATE with no
// WHERE fails ("DELETE requires a WHERE clause"). The SQL editor does not load it, so
// the verify scripts pass while the app breaks (eae4355). This guard scans every POS
// function body for such a statement.

const SUPABASE = new URL('../../../supabase/', import.meta.url)
// the menu back-office's own migrations (migration-*-menu-*.sql) are scanned too
const POS_MIGRATION = /^migration-.*-(pos|menu)-.*\.sql$/

/** Comments removed and string literals emptied; dollar quotes kept, since a
 *  function body is code. Line breaks are kept so error lines still match. */
function stripCommentsAndStrings(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1]
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
      out += "''"
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The bodies of `create [or replace] function … as $tag$ … $tag$`. */
function functionBodies(sql: string): { name: string; body: string }[] {
  const clean = stripCommentsAndStrings(sql)
  const re = /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\2/gi
  const out: { name: string; body: string }[] = []
  for (const m of clean.matchAll(re)) out.push({ name: m[1], body: m[3] })
  return out
}

/** Statements in a body that DELETE or UPDATE with no WHERE at their own level.
 *  `on conflict … do update set` and `select … for update` are not UPDATE statements. */
function unguardedWrites(body: string): string[] {
  const found: string[] = []
  for (const raw of body.split(';')) {
    const stmt = raw.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!stmt) continue
    // paren depth at every character, so a WHERE inside a subquery does not count
    const depth: number[] = []
    let d = 0
    for (const ch of stmt) {
      if (ch === '(') d++
      depth.push(d)
      if (ch === ')') d--
    }
    const writes = [...stmt.matchAll(/\b(delete\s+from|update)\b/g)].filter((m) => {
      if (m[1] !== 'update') return true
      const before = stmt.slice(0, m.index).trimEnd()
      if (/\b(do|for)$/.test(before)) return false                 // on conflict do update / for update
      return /^update\s+[\w."]+(\s+(as\s+)?\w+)?\s+set\b/.test(stmt.slice(m.index))
    })
    for (const m of writes) {
      const at = depth[m.index]
      let guarded = false
      for (const w of stmt.slice(m.index).matchAll(/\bwhere\b/g)) {
        const pos = m.index + w.index
        if (depth[pos] === at && !stmt.slice(m.index, pos).split('').some((_, k) => depth[m.index + k] < at)) {
          guarded = true
          break
        }
      }
      if (!guarded) found.push(stmt)
    }
  }
  return found
}

describe('pg-safeupdate guard: the checker itself', () => {
  const body = (s: string) => unguardedWrites(stripCommentsAndStrings(s))
  it('flags a bare delete or update', () => {
    expect(body('delete from pg_temp._x;')).toHaveLength(1)
    expect(body('update bills set pax = 2;')).toHaveLength(1)
    expect(body('update bills b set pax = 2;')).toHaveLength(1)
  })
  it('accepts a delete or update with a where, even where true', () => {
    expect(body('delete from pg_temp._x where true;')).toEqual([])
    expect(body('update bills set pax = 2 where id = v_id;')).toEqual([])
  })
  it('does not count a where that sits only inside a subquery', () => {
    expect(body('update bills set pax = (select max(p) from t where t.id = 1);')).toHaveLength(1)
  })
  it('ignores on conflict do update set, select for update, comments and strings', () => {
    expect(body('insert into t(a) values (1) on conflict (a) do update set b = excluded.b;')).toEqual([])
    expect(body('select * from bills where id = v_id for update;')).toEqual([])
    expect(body("-- delete from t;\nraise exception 'delete from t;';")).toEqual([])
  })
})

describe('pg-safeupdate guard: POS migrations', () => {
  const files = readdirSync(SUPABASE).filter((f) => POS_MIGRATION.test(f) && !f.includes('verify')).sort()

  it('reads the POS function migrations', () => {
    expect(files).toEqual(expect.arrayContaining([
      'migration-2026-10-22-pos-menu-import-fn.sql',
      'migration-2026-10-23-pos-ordering-fn.sql',
      'migration-2026-10-24-pos-catalogs-fn.sql',
      'migration-2026-10-24-pos-checkout-fn.sql',
      'migration-2026-10-24-pos-menu-editor-fn.sql',
      'migration-2026-10-24-pos-slots-photos-fn.sql',
      'migration-2026-10-24-pos-shifts.sql',
      'migration-2026-10-24-pos-shifts-fn.sql',
      'migration-2026-10-25-pos-hardening.sql',
      'migration-2026-10-25-menu-list-photo.sql',
    ]))
  })

  for (const f of files) {
    it(`${f}: every DELETE / UPDATE inside a function has a WHERE`, () => {
      const sql = readFileSync(new URL(f, SUPABASE), 'utf8')
      const offenders = functionBodies(sql).flatMap(({ name, body }) => unguardedWrites(body).map((s) => `${name}: ${s}`))
      expect(offenders).toEqual([])
    })
  }

  it('finds the functions it checks (the scan is not vacuous)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-catalogs-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining(['pos_insert_order', 'menu_import', 'menu_import_catalogs', 'save_branch_catalogs']))
  })

  it('scans every write function of the menu editor (M2)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-menu-editor-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'menu_save_product', 'menu_save_group', 'menu_save_catalog', 'menu_duplicate_catalog', 'menu_reorder_catalogs',
      'menu_set_catalog_active', 'menu_save_catalog_row', 'menu_save_category', 'menu_reorder_categories',
      'menu_set_category_active',
    ]))
  })

  it('scans every write function of time slots and photos (M3)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-slots-photos-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'menu_save_schedule', 'menu_reorder_schedules', 'menu_delete_schedule', 'menu_set_product_schedules',
      'menu_set_product_image', 'pos_insert_order', 'qr_menu',
    ]))
  })

  it('scans every write function of shifts (Sub-plan 4a)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-shifts-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'open_shift', 'record_cash_move', 'close_shift', 'pos_queue_zreport', 'reprint_zreport', 'save_shift_settings',
      'checkout_bill', 'refund_bill',
    ]))
  })

  it('scans every write function of the pre-pilot hardening', () => {
    const sql = readFileSync(new URL('migration-2026-10-25-pos-hardening.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'order_items_order_type', 'checkout_bill', 'void_order_item', 'pos_pin_attempt', 'set_my_pos_pin',
      'claim_print_job', 'finish_print_job', 'requeue_print_job',
    ]))
  })

  it('scans the menu back-office tidy-up: menu_product_list with photos, same grants, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-10-25-menu-list-photo.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(['menu_product_list'])
    expect(sql).toMatch(/security definer set search_path = public, pg_temp as \$\$/)
    expect(sql).toMatch(/'image_path', p\.image_path, 'image_updated_at', p\.image_updated_at/)
    expect(sql).toMatch(/revoke all on function menu_product_list\(\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function menu_product_list\(\) to authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: menu_products\.image_path is missing/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
  })
})
