// Edge Function: provision-staff
//
// 建员工账号唯一的服务端入口。存在的理由:创建 auth 用户必须用 service_role key,
// 而这个 key 一旦出现在前端就会被打进构建产物、任何访客都能提取,从而绕过全部 RLS。
// 把它关在这里,前端只带自己的 JWT 调用。
//
// 授权判断也一并移到服务端:调用者必须拥有 manage_staff。前端怎么改都绕不过去。
//
// 两个动作:
//   create  — 经理在 Directory 里手工加人
//   approve — 审批一条 registration_request
//
// 部署:
//   supabase functions deploy provision-staff
//   supabase secrets set SERVICE_ROLE_KEY=<key>   # 服务端密钥,不带 VITE_ 前缀
// 注意 SUPABASE_URL 与 SUPABASE_ANON_KEY 由平台自动注入,无需手动设置。

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

type SystemRole = 'owner' | 'admin' | 'hr' | 'manager' | 'supervisor' | 'staff'
type Rank = 'trainee' | 'junior' | 'senior' | 'supervisor' | 'manager'

/**
 * manage_staff 的内置默认值,必须与 src/shared/types/index.ts 的
 * DEFAULT_SYSTEM_ROLE_CAPS 保持一致。这里只复制了本函数需要的那一个能力,
 * 不是整张表 —— 复制越多,漂移的面越大。
 *
 * 长期方向是把这份判断下沉成一个 SQL security definer 函数
 * current_has_cap(text),让 Edge Function 与 RLS 策略共用同一个真值来源。
 */
const MANAGE_STAFF_DEFAULT: Record<SystemRole, boolean> = {
  owner: true, admin: true, hr: true, manager: true, supervisor: true, staff: false,
}

/** 与前端 rankToSystemRole() 同构。 */
function rankToSystemRole(rank: Rank | null | undefined): SystemRole {
  if (rank === 'manager') return 'manager'
  if (rank === 'supervisor') return 'supervisor'
  return 'staff'
}

/**
 * 解析调用者身份并判定是否可以建号。
 * 沿用前端的合并语义:system_role_permissions 的 jsonb 覆盖在代码默认值之上,
 * 缺 key 时回落到默认 —— 判断规则必须和前端一致,否则会出现"界面允许、后端拒绝"。
 */
async function authorize(
  admin: SupabaseClient,
  authHeader: string | null,
): Promise<{ ok: true; callerId: string } | { ok: false; status: number; error: string }> {
  if (!authHeader) return { ok: false, status: 401, error: 'Missing Authorization header' }

  const token = authHeader.replace(/^Bearer\s+/i, '')
  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData.user) return { ok: false, status: 401, error: 'Invalid session' }

  const callerId = userData.user.id
  const { data: caller } = await admin
    .from('staff')
    .select('system_role, rank, status')
    .eq('id', callerId)
    .maybeSingle()

  if (!caller) return { ok: false, status: 403, error: 'No staff profile for this account' }
  if (caller.status === 'resigned') return { ok: false, status: 403, error: 'Account is deactivated' }

  const role: SystemRole = caller.system_role ?? rankToSystemRole(caller.rank)

  const { data: overrideRow } = await admin
    .from('system_role_permissions')
    .select('permissions')
    .eq('system_role', role)
    .maybeSingle()

  const override = overrideRow?.permissions?.manage_staff
  const allowed = typeof override === 'boolean' ? override : MANAGE_STAFF_DEFAULT[role]

  if (!allowed) return { ok: false, status: 403, error: 'You do not have permission to create staff accounts' }
  return { ok: true, callerId }
}

/**
 * 岗位自动匹配 + 技能清单初始化。尽力而为:匹配不到唯一岗位就先不设,
 * 由经理事后手动指派 —— 这与改造前的行为一致,不要收紧成硬失败。
 */
async function assignJobTitle(admin: SupabaseClient, staffId: string, rank: Rank, dept: string | null) {
  if (!dept) return
  const { data: roleRows } = await admin
    .from('roles')
    .select('id')
    .eq('rank', rank)
    .eq('department', dept)
    .eq('is_active', true)
  if (roleRows && roleRows.length === 1) {
    await admin.from('staff').update({ job_title_id: roleRows[0].id }).eq('id', staffId)
    await admin.rpc('initialize_staff_skills', { p_staff_id: staffId })
  }
}

const today = () => new Date().toISOString().split('T')[0]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = Deno.env.get('SERVICE_ROLE_KEY')
  const url = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !url) return json({ error: 'Function is not configured' }, 500)

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const auth = await authorize(admin, req.headers.get('Authorization'))
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  // ── create ────────────────────────────────────────────────────────────────
  if (body.action === 'create') {
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    const rank = (body.rank ?? 'trainee') as Rank
    const branch = (body.branch as string) || null
    const department = (body.department as string) || null

    if (!name || !email || password.length < 6) {
      return json({ error: 'Name, email, and a 6+ character password are required.' }, 400)
    }

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (authErr || !authData.user) {
      return json({ error: authErr?.message ?? 'Failed to create auth user' }, 400)
    }

    const { error: profileErr } = await admin.from('staff').insert({
      id: authData.user.id,
      name,
      email,
      rank,
      // system_role 必须显式写入。列的默认值是 'staff',所以漏写会让一个
      // supervisor 拿到 staff 的能力集 —— 权限矩阵从此与实际不符。
      system_role: rankToSystemRole(rank),
      branch,
      department,
      onboarding_completed: rank === 'manager',
      joined_at: today(),
    })
    if (profileErr) {
      // 回滚刚建的 auth 用户,否则会留下一个孤儿账号,让这个邮箱再也建不了。
      await admin.auth.admin.deleteUser(authData.user.id)
      return json({ error: profileErr.message }, 400)
    }

    await assignJobTitle(admin, authData.user.id, rank, department)
    return json({ ok: true, staffId: authData.user.id })
  }

  // ── approve ───────────────────────────────────────────────────────────────
  if (body.action === 'approve') {
    const requestId = String(body.requestId ?? '')
    const email = String(body.email ?? '').trim()
    const fullName = String(body.fullName ?? '').trim()
    const password = String(body.password ?? '')
    const branch = (body.branch as string) || null
    const department = (body.department as string) || null
    const employmentType = (body.employmentType as string) || null
    const phone = (body.phone as string) || null

    if (!requestId || !email || password.length < 6) {
      return json({ error: 'Request id, email, and a 6+ character password are required.' }, 400)
    }

    // 建 auth 用户 —— 或者接管一个被中断的审批遗留下来的用户,否则半途失败过一次的
    // 邮箱会永远卡在 "already been registered" 上。
    let userId: string
    let createdNow = false
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (created?.user) {
      userId = created.user.id
      createdNow = true
    } else if (createErr && /already/i.test(createErr.message)) {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
      if (!existing) return json({ error: createErr.message }, 400)
      userId = existing.id
      // 重设密码,让交给经理的那串临时密码确实可用。
      await admin.auth.admin.updateUserById(userId, { password, email_confirm: true })
    } else {
      return json({ error: createErr?.message ?? 'Failed to create user' }, 400)
    }

    const { error: profileErr } = await admin.from('staff').upsert({
      id: userId,
      name: fullName,
      email,
      rank: 'trainee',
      system_role: 'staff',
      branch,
      department,
      employment_type: employmentType,
      contact_number: phone,
      onboarding_completed: false,
      joined_at: today(),
    }, { onConflict: 'id' })
    if (profileErr) {
      if (createdNow) await admin.auth.admin.deleteUser(userId)
      return json({ error: profileErr.message }, 400)
    }

    await assignJobTitle(admin, userId, 'trainee', department)

    await admin.from('registration_requests').update({
      status: 'approved',
      reviewed_by: auth.callerId,
      reviewed_at: new Date().toISOString(),
    }).eq('id', requestId)

    return json({ ok: true, staffId: userId })
  }

  return json({ error: `Unknown action: ${String(body.action)}` }, 400)
})
