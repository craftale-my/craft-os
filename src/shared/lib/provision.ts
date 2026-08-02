import { supabase } from './supabase'

/**
 * 建员工账号的客户端入口。
 *
 * 这些操作需要 service_role 权限,而那把 key 绝不能出现在前端 —— Vite 会把
 * VITE_ 前缀的变量内联进构建产物,等于公开一把绕过全部 RLS 的钥匙。所以真正的
 * 动作在 supabase/functions/provision-staff 里执行,这里只负责发请求。
 *
 * invoke() 会自动带上当前会话的 access token,函数据此判定调用者有没有
 * manage_staff —— 授权在服务端,前端改不动。
 */

export interface CreateStaffInput {
  name: string
  email: string
  password: string
  rank: string
  branch?: string | null
  department?: string | null
}

export interface ApproveRegistrationInput {
  requestId: string
  email: string
  fullName: string
  password: string
  branch?: string | null
  department?: string | null
  employmentType?: string | null
  phone?: string | null
}

type Result = { ok: true; staffId: string } | { ok: false; error: string }

async function call(body: Record<string, unknown>): Promise<Result> {
  const { data, error } = await supabase.functions.invoke('provision-staff', { body })

  if (error) {
    // 函数返回非 2xx 时,真正的原因在响应体里而不是 error.message
    // (后者一律是 "Edge Function returned a non-2xx status code")。
    let detail = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json()
        if (parsed?.error) detail = parsed.error
      } catch {
        // 响应体不是 JSON,保留原始 message
      }
    }
    return { ok: false, error: detail }
  }

  if (data?.error) return { ok: false, error: data.error }
  if (!data?.staffId) return { ok: false, error: 'Unexpected response from provision-staff' }
  return { ok: true, staffId: data.staffId }
}

export function createStaff(input: CreateStaffInput) {
  return call({ action: 'create', ...input })
}

export function approveRegistration(input: ApproveRegistrationInput) {
  return call({ action: 'approve', ...input })
}
