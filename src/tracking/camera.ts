import type { CameraFacing } from './types'

/** Coarse pointer and a small screen is a good enough phone check for picking settings. */
export function isLikelyPhone(): boolean {
  return window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820
}

/**
 * Opens the camera. Phones get a lower resolution so MediaPipe keeps up;
 * both ask for the highest frame rate the device offers, since cuts and
 * spins are fast.
 */
export async function openCamera(facing: CameraFacing): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser has no camera access. Open the app over HTTPS in a recent Chrome, Safari or Firefox.')
  }
  const phone = isLikelyPhone()
  const video: MediaTrackConstraints = {
    facingMode: { ideal: facing },
    width: { ideal: phone ? 640 : 1280 },
    height: { ideal: phone ? 480 : 720 },
    frameRate: { ideal: 60, min: 24 },
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false })
  } catch (err) {
    // Some devices reject the frame-rate floor; retry with the bare minimum.
    if (err instanceof DOMException && err.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false })
    }
    throw err
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

/** Whether the device has more than one camera, so the switch button is worth showing. */
export async function hasMultipleCameras(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput').length > 1
  } catch {
    return false
  }
}

export function describeCameraError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again.'
      case 'NotFoundError':
        return 'No camera was found on this device.'
      case 'NotReadableError':
        return 'The camera is in use by another app. Close it and try again.'
    }
  }
  return err instanceof Error ? err.message : String(err)
}
