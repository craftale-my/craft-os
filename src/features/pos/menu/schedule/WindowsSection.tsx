// src/features/pos/menu/schedule/WindowsSection.tsx
import { DAY_NAMES, MAX_WINDOWS, windowLabel, windowProblem } from '../timeSlots'
import { addWindow, removeWindow, toggleDay, updateWindow, type ScheduleForm } from '../scheduleForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** The schedule's time windows: days of the week and a from–to time each. */
export default function WindowsSection({ form, onChange, problem }: {
  form: ScheduleForm
  onChange: (f: ScheduleForm) => void
  problem: string | null
}) {
  return (
    <Section title="Time windows" problem={problem}
      hint="Malaysia time. Both minutes count: 10:00–23:59 runs to midnight. A window that ends before it starts runs past midnight (22:00–02:00 is Friday night when Friday is ticked).">
      <ul className="space-y-3">
        {form.windows.map((w, i) => (
          <li key={w.key} className="space-y-2 rounded border border-border p-3">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Days of window ${i + 1}`}>
              {DAY_NAMES.map((name, k) => {
                const day = k + 1
                const on = w.days.includes(day)
                return (
                  <button key={name} type="button" aria-pressed={on} onClick={() => onChange(toggleDay(form, w.key, day))}
                    className={`rounded px-2 py-1 text-sm ${on ? 'bg-brown-btn text-white' : 'border border-border'}`}>
                    {name}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">From
                <input type="time" step={60} className={inputCls} value={w.start} aria-label={`Window ${i + 1} from`}
                  onChange={(e) => onChange(updateWindow(form, w.key, { start: e.target.value }))} />
              </label>
              <label className="flex items-center gap-1">to
                <input type="time" step={60} className={inputCls} value={w.end} aria-label={`Window ${i + 1} to`}
                  onChange={(e) => onChange(updateWindow(form, w.key, { end: e.target.value }))} />
              </label>
              <span className="flex-1 text-xs text-brown-muted">{windowProblem(w) ? '' : windowLabel(w)}</span>
              <button type="button" className={linkBtnCls} disabled={form.windows.length === 1} aria-label={`Remove window ${i + 1}`}
                onClick={() => onChange(removeWindow(form, w.key))}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className={linkBtnCls} disabled={form.windows.length >= MAX_WINDOWS} onClick={() => onChange(addWindow(form))}>
        Add time window
      </button>
    </Section>
  )
}
