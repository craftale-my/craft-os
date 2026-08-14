import { useCan } from '../../shared/lib/permissions'

/**
 * 这个模块的门禁,一次讲完,三个页面共用。
 *
 * 分成两条不是为了对称,是因为 RLS 本来就分成两条
 * (`supabase/migration-2026-08-14-tasks-projects.sql`):
 *
 * ```
 * tasks_select / tasks_insert / tasks_update    → has_task_cap('view_team')
 * tasks_delete                                  → view_team 且(自己建的 或 manage_projects)
 * projects_manage / tags_update / tags_delete   → has_task_cap('manage_projects')
 * ```
 *
 * 在这之前,`Projects.tsx` 用的是 `can('manage_projects')`,而 `Tasks.tsx` 与
 * `ProjectDetail.tsx` 各自写了一份 `rank === 'supervisor' || rank === 'manager'`。
 * `Rank` 里根本没有 owner / admin / hr 这几格 —— `system_role = 'owner'` 而
 * `rank = 'senior'` 是完全正常的一笔资料。那个人手上 view_team 与 manage_projects
 * 都有,却会在 `/team/projects/:id` 的同一排按钮里看到「Edit 有、+ New Task 没有」,
 * 而且拖不动任何不是指派给自己的卡 —— 那张卡的 tasks_update 其实是放行的。
 *
 * UI 门禁不是安全边界,RLS 才是。所以这里一律对齐 RLS,不另外收紧:多收紧一格,
 * 换来的只是一颗资料库其实肯让他按的灰按钮,以及一个查不出原因的使用者。
 */
export function useTaskPermissions() {
  const { can } = useCan()
  return {
    /**
     * 板上的任务:新增、编辑、拖动换栏、传附件。对齐 tasks_insert / tasks_update
     * 的 `view_team` —— 也就是「进得来这块板的人」,与设计文档第四节
     * 「使用者全是管理层,刻意宽松」同一句话。
     */
    canManageTasks: can('view_team'),
    /**
     * 专案本体的 CRUD 与 tag 词表的改名 / 换色 / 删除。对齐 projects_manage 与
     * tags_update / tags_delete 的 `manage_projects`。
     *
     * 刻意不拿它当任务的门禁:这颗开关的语意是「能不能管专案与 tag 词表」,
     * Owner 在 Settings → System Roles 把它关掉,不该顺手把那个角色的
     * 任务编辑权也一起关掉。
     */
    canManageProjects: can('manage_projects'),
  }
}

/**
 * 删除任务比板上其它写入紧一格,对齐 tasks_delete:
 * `view_team and (created_by = auth.uid() or manage_projects)`。
 *
 * 单独一支纯函式而不是塞进上面那支 hook:它吃的是「哪一张卡」,每张卡的答案
 * 不一样,不是这个人的一个固定属性。
 */
export function canDeleteTask(
  perms: { canManageTasks: boolean; canManageProjects: boolean },
  task: { created_by: string | null },
  currentStaffId: string,
): boolean {
  return perms.canManageTasks
    && (task.created_by === currentStaffId || perms.canManageProjects)
}
