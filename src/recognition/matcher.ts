import type { MatcherRequest, MatchQuery, MatchResult } from './matcher.worker'
import type { SelfTestResult, Template } from './recognizer'

/** Runs DTW matching in a Web Worker so tracking and the UI stay smooth. */
export class Matcher {
  private worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, (v: unknown) => void>()

  constructor() {
    this.worker.onmessage = (
      e: MessageEvent<{ id: number; match?: MatchResult; ms?: number; result?: SelfTestResult; outliers?: string[] }>,
    ) => {
      const resolve = this.pending.get(e.data.id)
      this.pending.delete(e.data.id)
      resolve?.(e.data)
    }
  }

  private post(msg: MatcherRequest) {
    this.worker.postMessage(msg)
  }

  /** Loads templates; resolves with the ids of outlier takes, which are left out of matching. */
  setTemplates(templates: Template[]): Promise<string[]> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, (v) => resolve((v as { outliers: string[] }).outliers))
      this.post({ type: 'templates', id, templates })
    })
  }

  match(query: MatchQuery, threshold: number): Promise<{ result: MatchResult; ms: number }> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, (v) => {
        const d = v as { match: MatchResult; ms: number }
        resolve({ result: d.match, ms: d.ms })
      })
      this.post({ type: 'match', id, query, threshold })
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
