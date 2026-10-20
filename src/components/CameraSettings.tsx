import type { ReactNode } from 'react'

/** Bottom sheet for the camera screen's less-used options. */
export function CameraSettings({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings" role="dialog" aria-label="Camera settings" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          <h2>Settings</h2>
          <button className="link" onClick={onClose}>
            Done
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
