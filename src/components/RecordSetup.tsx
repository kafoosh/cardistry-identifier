import type { RecordSetupValue } from '../recording/recordSetup'
import type { CameraView, DominantHand } from '../recording/types'
import { MovePicker } from './MovePicker'

/** "What are you recording?" — declared before the countdown, kept for the next takes. */
export function RecordSetup({ value, onChange, disabled }: { value: RecordSetupValue; onChange: (v: RecordSetupValue) => void; disabled?: boolean }) {
  return (
    <fieldset className="record-setup" disabled={disabled}>
      <label className="field">
        <span>What are you recording?</span>
        <MovePicker value={value.moveName} onChange={(moveName) => onChange({ ...value, moveName })} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Camera angle</span>
          <select value={value.cameraView} onChange={(e) => onChange({ ...value, cameraView: e.target.value as CameraView })}>
            <option value="front">Front</option>
            <option value="top-down">Top-down</option>
            <option value="side">Side</option>
          </select>
        </label>
        <label className="field">
          <span>Dominant hand</span>
          <select value={value.dominantHand} onChange={(e) => onChange({ ...value, dominantHand: e.target.value as DominantHand })}>
            <option value="right">Right</option>
            <option value="left">Left</option>
          </select>
        </label>
      </div>
    </fieldset>
  )
}
