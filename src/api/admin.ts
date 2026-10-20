import { API_BASE } from '../config'
import { deviceId } from './client'

const TOKEN_KEY = 'cardistry.adminToken'

export function adminToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setAdminToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private mode: the token lasts for this visit only.
  }
}

export interface AdminMove {
  id: string
  name: string
  slug: string
  aliases: string[]
  category: string | null
  description: string | null
  creditedTo: string | null
  status: 'approved' | 'proposed' | 'rejected' | 'merged'
  recordingCount: number
  mergedInto: string | null
  createdBy: string | null
  createdAt: number
}

export interface AdminRecording {
  id: string
  moveId: string
  moveName: string
  deviceId: string
  nickname: string | null
  fps: number
  frameCount: number
  durationMs: number
  handedness: string | null
  cameraView: string | null
  camera: 'user' | 'environment' | null
  device: string | null
  qualityScore: number
  status: 'approved' | 'pending' | 'rejected'
  createdAt: number
}

export interface AdminReport {
  id: string
  targetType: string
  targetId: string
  reason: string | null
  createdAt: number
}

export interface AdminSettings {
  acceptProposedMoves: boolean
}

export interface AdminOverview {
  settings: AdminSettings
  moves: AdminMove[]
  recordings: AdminRecording[]
  reports: AdminReport[]
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: 'no-cache',
    headers: {
      'X-Device-Id': deviceId(),
      'X-Admin-Token': adminToken(),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // Not JSON.
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

const patch = <T>(path: string, body: unknown) => call<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

export const fetchOverview = () => call<AdminOverview>('/api/admin/overview')

export const saveSettings = (settings: Partial<AdminSettings>) =>
  patch<{ settings: AdminSettings }>('/api/admin/settings', settings).then((r) => r.settings)

export const updateMove = (id: string, change: { status?: AdminMove['status']; name?: string; mergeInto?: string }) =>
  patch<{ move: AdminMove }>(`/api/admin/moves/${id}`, change)

export const updateRecording = (id: string, status: AdminRecording['status']) =>
  patch<{ recording: AdminRecording }>(`/api/admin/recordings/${id}`, { status })

export const deleteRecording = (id: string) =>
  call<{ deleted: true }>(`/api/admin/recordings/${id}`, { method: 'DELETE' })

export const resolveReport = (id: string) => patch<{ resolved: true }>(`/api/admin/reports/${id}`, {})
