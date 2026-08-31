import type { ReactElement } from 'react'

/**
 * Hand-authored inline SVG icons (Lucide-style: 24x24 viewbox, 1.75 stroke, round caps).
 * No icon-font/emoji dependency per design guidelines — vector, themeable via currentColor.
 */
interface IconProps {
  size?: number
  className?: string
}

const BASE_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function IconUpload({ size = 16, className }: IconProps): ReactElement {
  return (
    <svg {...BASE_PROPS} width={size} height={size} className={className}>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

export function IconDownload({ size = 16, className }: IconProps): ReactElement {
  return (
    <svg {...BASE_PROPS} width={size} height={size} className={className}>
      <path d="M12 4v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

export function IconChevronDown({ size = 14, className }: IconProps): ReactElement {
  return (
    <svg {...BASE_PROPS} width={size} height={size} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function IconImage({ size = 18, className }: IconProps): ReactElement {
  return (
    <svg {...BASE_PROPS} width={size} height={size} className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.75" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}
