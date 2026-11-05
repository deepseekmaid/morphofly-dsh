import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold, finalAssistantOutput } from '../src/assistant-output.ts'

function message(content: ContentBlock[]): SessionEvent {
  return { type: 'assistant/message', data: { message: { content } } } as unknown as SessionEvent
}

function discardedAttempt(): SessionEvent {
  return { type: 'assistant/attempt', data: { turn: 1, step: 1 } } as unknown as SessionEvent
}

function toolResult(text: string): SessionEvent {
  return {
    type: 'tool/result',
    data: {
      message: {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text }],
        isError: false,
      },
    },
  } as unknown as SessionEvent
}

describe('finalAssistantOutput', () => {
  it('selects the last non-empty message past a later empty usage-only message', () => {
    const events = [
      message([{ type: 'text', text: 'step one' }]),
      message([{ type: 'text', text: 'step two' }]),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'step two' }])
  })

  it('treats textless assistant content as a non-empty message', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'complete reasoning' }]
    expect(finalAssistantOutput([discardedAttempt(), message(content)])).toEqual(content)
  })

  it('ignores tool-result content and log-only attempts for the message selection', () => {
    const events = [
      discardedAttempt(),
      toolResult('tool output'),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toBeUndefined()
  })

  it('returns undefined when the child produced no messages', () => {
    expect(finalAssistantOutput([])).toBeUndefined()
    expect(finalAssistantOutput([discardedAttempt(), toolResult('tool output')])).toBeUndefined()
  })
})

describe('AssistantOutputFold', () => {
  it('prefers a non-empty message over text accumulated before and after it', () => {
    const fold = new AssistantOutputFold()
    fold.pushText('earlier partial')
    fold.push(message([{ type: 'text', text: 'complete answer' }]))
    fold.pushText('later partial')
    fold.push(message([]))
    expect(fold.collect()).toEqual([{ type: 'text', text: 'complete answer' }])
  })

  it('falls back to text pushed outside session events', () => {
    const fold = new AssistantOutputFold()
    fold.push(discardedAttempt())
    fold.pushText('partial ')
    fold.push(toolResult('tool output'))
    fold.pushText('answer')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('folds raw text pieces into the same streamed fallback (ACP chunk transport)', () => {
    const fold = new AssistantOutputFold()
    fold.pushText('partial ')
    fold.pushText('')
    fold.pushText('answer')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('collects undefined until any output is folded', () => {
    expect(new AssistantOutputFold().collect()).toBeUndefined()
  })
})
