const foo = require('./foo')
const empty = require('')
require('./sideeffect')
const { a } = require('./bar')
console.log(require('./bar'))
const zero = require()
const two = require('./a', './b')
const dyn = require(modulePath)

function thing() {}
function bar() {}
function whole() {}

module.exports.thing = thing
exports.bar = bar
module.exports = whole

let x = 1
x = 2
someOther.thing = 1
