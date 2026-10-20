import type { FeatureSequence } from './features'
import type { MatcherRequest } from './matcher.worker'
import type { MoveScore, SelfTestResult, Template } from './recognizer'

/** Runs DTW matching in a Web Worker so tracking and the UI stay smooth. */
export class Matcher {
  private worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, (v: unknown) => void>()

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; scores?: MoveScore[]; ms?: number; result?: SelfTestResult }>) => {
      const resolve = this.pending.get(e.data.id)
      this.pending.delete(e.data.id)
      resolve?.(e.data)
    }
  }

  private post(msg: MatcherRequest) {
    this.worker.postMessage(msg)
  }

  setTemplates(templates: Template[]) {
    this.post({ type: 'templates', templates })
  }

  match(windows: FeatureSequence[], threshold: number): Promise<{ scores: MoveScore[]; ms: number }> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void)
      this.post({ type: 'match', id, windows, threshold })
    })
  }

  selfTest(): Promise<SelfTestResult> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, (v) => resolve((v as { result: SelfTestResult }).result))
      this.post({ type: 'selftest', id })
    })
  }

  terminate() {
    this.worker.terminate()
  }
}
