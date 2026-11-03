import { useMemo } from 'react'

interface Item { id: string }

export function List<T extends Item>({ items }: { items: T[] }) {
  const ids = useMemo(() => items.map(item => item.id), [items])
  return <ul>{ids.map(id => <li key={id}>{id}</li>)}</ul>
}
