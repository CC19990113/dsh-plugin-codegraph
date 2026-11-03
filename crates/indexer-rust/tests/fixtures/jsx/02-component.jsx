import { useState } from 'react'

export function Counter() {
  const [n, setN] = useState(0)
  return (
    <div className="counter">
      <span>{n}</span>
      <button onClick={() => setN(n + 1)}>add</button>
    </div>
  )
}

export function List({ items }) {
  return <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
}
