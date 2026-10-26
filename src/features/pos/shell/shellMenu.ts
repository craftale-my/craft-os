// src/features/pos/shell/shellMenu.ts
/** The bottom bar's grid menu and clock (spec §1). */

export type MenuItem = 'order' | 'menu' | 'transaction' | 'report' | 'setting'

export const MENU_LABEL: Record<MenuItem, string> = {
  order: 'Order', menu: 'Menu', transaction: 'Transaction', report: 'Report', setting: 'Setting',
}

/** Menu is the menu back office (/menu needs manage_menu); Report is the closed shifts and
 *  their Z reports (pos_supervise, as the old Shifts button); Setting is /pos/settings
 *  (access_settings). Each is shown only to those its page lets in. */
export function menuItems(caps: { manageMenu: boolean; supervise: boolean; settings: boolean }): MenuItem[] {
  const all: MenuItem[] = ['order', 'menu', 'transaction', 'report', 'setting']
  return all.filter((i) => (i !== 'menu' || caps.manageMenu) && (i !== 'report' || caps.supervise) && (i !== 'setting' || caps.settings))
}

/** "09:05" on the Malaysia clock (UTC+8, no daylight saving), whatever the iPad's time zone. */
export function mytClock(nowMs: number): string {
  const d = new Date(nowMs + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
