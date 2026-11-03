import { bar as renamed } from './bar'
import * as ns from './ns'
import './side'
import Def from ''

obj.parse(x)
obj[key](x)
const value = 5
let uninitialized: number
const { a, b } = obj

function outer() {
  const local = 1
  return local
}

arr.forEach(function (item) {
  const total = compute(item)
  return total
})

const y = (() => {
  const arrowLocal = 2
  return arrowLocal
})()

class Fields {
  x = 1
  static y = 2
  #priv = 3
  ordinary() {}
}

enum Color { Red, Blue }
enum Valued { Green = 5 }
