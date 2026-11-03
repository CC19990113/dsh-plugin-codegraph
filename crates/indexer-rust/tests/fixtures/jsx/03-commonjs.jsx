const React = require('react')

function Widget() {
  return <div className="widget">text</div>
}

function helper() { return Widget() }

module.exports.Widget = Widget
module.exports.helper = helper
