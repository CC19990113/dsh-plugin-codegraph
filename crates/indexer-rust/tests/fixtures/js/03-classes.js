class Base {}
class Foo extends Base {
  x = 1
  static y = 2
  constructor() { super() }
  async load() { return fetch(this.x) }
}
class Expr extends (class {}) {}
class Qualified extends ns.Base {}
var topVar = 1
