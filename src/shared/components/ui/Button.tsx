import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { LinkProps } from 'react-router-dom'

export type ButtonVariant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

// The app's existing button looks, collected in one place.
// primary = caramel accent, dark = brown, secondary = outlined.
const VARIANTS: Record<ButtonVariant, string> = {
  primary:   'bg-accent text-white hover:bg-accent-hover',
  dark:      'bg-brown-btn text-white hover:bg-brown-btn-hover',
  secondary: 'bg-white text-brown-brand border border-border-mid hover:bg-cream',
  ghost:     'text-brown-muted hover:bg-cream hover:text-brown-dark',
  danger:    'bg-bad text-white hover:bg-[#86391F]',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-base gap-2 rounded-xl',
}

const BASE =
  'inline-flex items-center justify-center font-semibold whitespace-nowrap transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra = '') {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim()
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
}

export function Button({ variant = 'primary', size = 'md', icon, className = '', type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} {...rest}>
      {icon}
      {children}
    </button>
  )
}

type ButtonLinkProps = LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }

export function ButtonLink({ variant = 'primary', size = 'md', icon, className = '', children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  )
}
