import { useState } from 'react'
import type { FC } from 'react'

export interface Props { title: string; count?: number }

export const Counter: FC<Props> = ({ title, count = 0 }) => {
  const [value, setValue] = useState(count)
  return (
    <section className="counter">
      <h1>{title}</h1>
      <button onClick={() => setValue(value + 1)}>{value}</button>
    </section>
  )
}

export default function App() {
  return <Counter title="demo" />
}
