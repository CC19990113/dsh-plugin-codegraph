export function foo(a: number): number {
  return bar(a)
}
class MathHelper {
  static async calc(x: number) {
    return foo(x)
  }
}
export const arrow = (x: number) => foo(x)
export default function baz() {}
import { bar } from './bar'
import Def from './def'
interface Thing { x: number }
type Alias = number
