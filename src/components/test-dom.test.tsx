import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { installTestDom } from './test-dom'

describe('test dom', () => {
  it('renders a button and runs its click', async () => {
    const { container } = installTestDom()
    const root = createRoot(container as unknown as Element)
    function Probe() {
      const [sent, setSent] = useState(false)
      return createElement('button', { type: 'button', onClick: () => setSent(true) }, sent ? 'sent' : 'form')
    }
    await act(async () => { root.render(createElement(Probe)) })
    expect(container.textContent).toContain('form')
    const button = container.childNodes[0] as unknown as { click: () => void }
    await act(async () => { button.click() })
    expect(container.textContent).toContain('sent')
    await act(async () => { root.unmount() })
  })
})
