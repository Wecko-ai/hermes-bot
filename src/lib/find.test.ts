import { describe, expect, it } from 'vitest'
import { installTestDom } from '../components/test-dom'
import { completedMessageStamp, findMatches, findRanges, isFinishedMessageContent } from './find'

describe('findMatches', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(findMatches('Alpha beta ALPHA alpha', 'alpha')).toEqual([[0, 5], [11, 16], [17, 22]])
  })

  it('ignores accents in both directions and keeps offsets in the original text', () => {
    expect(findMatches('Écoute: ecole, école', 'ecole')).toEqual([[8, 13], [15, 20]])
    expect(findMatches('cafe', 'café')).toEqual([[0, 4]])
  })

  it('does not overlap and returns nothing for an empty query', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
    expect(findMatches('abc', '  ')).toEqual([])
  })

  it('keeps the same stamp while a streaming bubble grows, then changes when the reply is finished', () => {
    const done = { id: 'a', content: 'Hello' }
    const streaming = (content: string) => ({ id: 'live', content, streaming: true as const })
    expect(completedMessageStamp([done, streaming('He')])).toBe(completedMessageStamp([done, streaming('Hello')]))
    expect(completedMessageStamp([done, { id: 'live', content: 'Hello' }])).not.toBe(completedMessageStamp([done, streaming('Hello')]))
  })

  it('skips a streaming message and searches a finished one', () => {
    expect(isFinishedMessageContent({ closest: (selector) => (selector === '.is-streaming' ? {} : null) })).toBe(false)
    expect(isFinishedMessageContent({ closest: () => null })).toBe(true)
  })

  it('walks finished messages and leaves a streaming bubble out of the ranges', () => {
    const { document, container } = installTestDom()
    const streaming = document.createElement('article')
    streaming.className = 'message is-streaming'
    const streamingBody = document.createElement('div')
    streamingBody.className = 'message-content'
    streamingBody.textContent = 'alpha secret'
    streaming.appendChild(streamingBody)
    const done = document.createElement('div')
    done.className = 'message-content'
    done.textContent = 'alpha visible'
    container.appendChild(streaming)
    container.appendChild(done)
    const ranges = findRanges(container as unknown as HTMLElement, 'alpha')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer.textContent).toBe('alpha visible')
  })
})
