function foo() { return bar() }
const arrow = x => baz(x)
class Widget {
  render() { return foo() }
}
foo()
