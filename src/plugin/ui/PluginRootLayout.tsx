import type { ReactNode } from 'react'

/** Keeps the plugin view, backend notice, and residency status in separate layout rows. */
export function PluginRootLayout({ header, children, footer }: { header?: ReactNode; children: ReactNode; footer?: ReactNode }): JSX.Element {
  return (
    <div className="plugin-root-layout">
      {header}
      <div className="plugin-renderer-slot">{children}</div>
      {footer}
    </div>
  )
}
