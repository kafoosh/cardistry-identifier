import { Matcher } from './matcher'

let matcher: Matcher | null = null

/** One matcher worker for the whole app. */
export function getMatcher(): Matcher {
  matcher ??= new Matcher()
  return matcher
}
