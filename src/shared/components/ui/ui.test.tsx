// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Button, ButtonLink, Badge, PageHeader, SegmentedTabs, buttonClasses } from '.'

afterEach(cleanup)

describe('Button', () => {
  it('defaults to a primary pill of type button', () => {
    render(<Button>Clock in</Button>)
    const b = screen.getByRole('button', { name: 'Clock in' })
    expect(b.getAttribute('type')).toBe('button')
    expect(b.className).toContain('rounded-xl')
    expect(b.className).toContain('bg-accent')
  })

  it('keeps outlined and ghost buttons free of white text', () => {
    for (const v of ['secondary', 'ghost'] as const) {
      expect(buttonClasses(v)).not.toContain('text-white')
    }
  })

  it('ButtonLink renders an anchor with the same styling', () => {
    render(<MemoryRouter><ButtonLink to="/x" variant="secondary">Open</ButtonLink></MemoryRouter>)
    const a = screen.getByRole('link', { name: 'Open' })
    expect(a.getAttribute('href')).toBe('/x')
    expect(a.className).toContain('border-border-mid')
  })
})

describe('Badge', () => {
  it('pairs each tint with its own dark text', () => {
    render(<Badge tone="danger">Late</Badge>)
    const el = screen.getByText('Late')
    expect(el.className).toContain('bg-bad-bg')
    expect(el.className).toContain('text-bad')
  })
})

describe('PageHeader', () => {
  it('renders a single h1 with optional eyebrow and actions', () => {
    render(<PageHeader eyebrow="Good morning" title="Aina" actions={<button>Go</button>} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Aina' })).toBeTruthy()
    expect(screen.getByText('Good morning')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
  })
})

describe('SegmentedTabs', () => {
  it('marks the active tab and reports clicks', () => {
    const onChange = vi.fn()
    render(
      <SegmentedTabs
        label="Profile sections"
        value="a"
        onChange={onChange}
        tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', dot: true }]}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('Wordmark', () => {
  it('reads as the full product name and shows both lockup lines', async () => {
    const { Wordmark } = await import('.')
    render(<Wordmark />)
    expect(screen.getByRole('img', { name: 'Craft Cafe Operation System' })).toBeTruthy()
    expect(screen.getByText('Craft Cafe')).toBeTruthy()
    expect(screen.getByText('Operation System')).toBeTruthy()
  })
})
