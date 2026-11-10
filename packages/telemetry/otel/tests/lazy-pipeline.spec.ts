/** SDK pipelines stay unloaded until the first record reaches the reporter. */
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { ExportResultCode } from '@opentelemetry/core'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import { afterEach, expect, it, vi } from 'vitest'
import type { EventLogOptions } from '../src/event-log.ts'
import type { SessionLogOptions, SessionLogRecord } from '../src/session-log.ts'

afterEach(() => { vi.restoreAllMocks() })

function exporter(): LogRecordExporter {
  return {
    export: (_records, callback) => { callback({ code: ExportResultCode.SUCCESS }) },
    forceFlush: async () => {},
    shutdown: async () => {},
  }
}

const onFailure = (): SessionLogOptions['onFailure'] => vi.fn()

function options(failure: SessionLogOptions['onFailure'] = onFailure()): EventLogOptions & SessionLogOptions {
  return {
    scope: { name: 'lazy-test' },
    exporter: { url: 'http://collector.test/v1/logs', timeoutMillis: 1000 },
    resourceAttributes: {},
    processor: { scheduledDelayMillis: 60_000 },
    onFailure: failure,
  }
}

const event = { eventName: 'synthetic', body: 'Synthetic test', timestamp: 1_800_000_000_000 }

function sessionRecord(text: string): SessionLogRecord {
  return {
    sessionId: SessionId('lazy-session'),
    event: {
      type: 'user/message', seq: SessionSeq(0), time: 1_800_000_000_000, surfaceOp: 'append',
      data: { content: [{ type: 'text', text }] },
    },
  }
}

it('creates no Session-log exporter before the first record', async () => {
  const transport = await import('../src/transport.ts')
  const create = vi.spyOn(transport, 'createLogExporter').mockReturnValue(exporter())
  const { SessionLogReporter } = await import('../src/session-log.ts')
  const sender = new SessionLogReporter(options())
  expect(create).not.toHaveBeenCalled()
  await sender.shutdown()
  expect(create).not.toHaveBeenCalled()
})

it('creates no ordinary-event exporter before the first event', async () => {
  const transport = await import('../src/event-transport.ts')
  const create = vi.spyOn(transport, 'createEventLogExporter').mockReturnValue(exporter())
  const { EventLogReporter } = await import('../src/event-log.ts')
  const sender = new EventLogReporter(options())
  expect(create).not.toHaveBeenCalled()
  await sender.shutdown()
  expect(create).not.toHaveBeenCalled()
})

it('drops Session-log records after stopPending without loading a pipeline', async () => {
  const transport = await import('../src/transport.ts')
  const create = vi.spyOn(transport, 'createLogExporter')
  const { SessionLogReporter } = await import('../src/session-log.ts')
  const sender = new SessionLogReporter(options())
  sender.stopPending()
  sender.reportSessionLog(sessionRecord('after stop'))
  expect(create).not.toHaveBeenCalled()
  await sender.shutdown()
  expect(create).not.toHaveBeenCalled()
})

it('reports a Session-log load failure once and drops later records', async () => {
  const transport = await import('../src/transport.ts')
  const failure = onFailure()
  vi.spyOn(transport, 'createLogExporter').mockImplementation(() => { throw new Error('synthetic Session-log load failure') })
  const { SessionLogReporter } = await import('../src/session-log.ts')
  const sender = new SessionLogReporter(options(failure))
  sender.reportSessionLog(sessionRecord('first'))
  expect(failure).toHaveBeenCalledTimes(1)
  expect(failure).toHaveBeenCalledWith('Session log pipeline failed to load', expect.objectContaining({ message: 'synthetic Session-log load failure' }))
  sender.reportSessionLog(sessionRecord('later'))
  expect(failure).toHaveBeenCalledTimes(1)
  await expect(sender.shutdown()).resolves.toBeUndefined()
})

it('reports an ordinary-event load failure once and drops later events', async () => {
  const transport = await import('../src/event-transport.ts')
  const failure = onFailure()
  vi.spyOn(transport, 'createEventLogExporter').mockImplementation(() => { throw new Error('synthetic event load failure') })
  const { EventLogReporter } = await import('../src/event-log.ts')
  const sender = new EventLogReporter(options(failure))
  sender.emit(event)
  expect(failure).toHaveBeenCalledTimes(1)
  expect(failure).toHaveBeenCalledWith('Product telemetry pipeline failed to load', expect.objectContaining({ message: 'synthetic event load failure' }))
  sender.emit(event)
  expect(failure).toHaveBeenCalledTimes(1)
  await expect(sender.shutdown()).resolves.toBeUndefined()
})

it('keeps one Session-log pipeline across records and stops its queue', async () => {
  const failure = onFailure()
  const { SessionLogReporter } = await import('../src/session-log.ts')
  const sender = new SessionLogReporter({ ...options(failure), processor: { scheduledDelayMillis: 60_000 } })
  sender.reportSessionLog(sessionRecord('one'))
  sender.reportSessionLog(sessionRecord('two'))
  sender.stopPending()
  sender.reportSessionLog(sessionRecord('after stop'))
  await expect(sender.shutdown()).resolves.toBeUndefined()
  expect(failure).not.toHaveBeenCalled()
})

it('reports a non-Error Session-log load failure', async () => {
  const transport = await import('../src/transport.ts')
  const failure = onFailure()
  vi.spyOn(transport, 'createLogExporter').mockImplementation(() => { throw 'synthetic non-Error' })
  const { SessionLogReporter } = await import('../src/session-log.ts')
  const sender = new SessionLogReporter(options(failure))
  sender.reportSessionLog(sessionRecord('first'))
  expect(failure).toHaveBeenCalledWith('Session log pipeline failed to load', expect.objectContaining({ message: 'synthetic non-Error' }))
})

it('reuses the ordinary-event pipeline and reports a non-Error load failure', async () => {
  const transport = await import('../src/event-transport.ts')
  const create = vi.spyOn(transport, 'createEventLogExporter').mockReturnValue(exporter())
  const { EventLogReporter } = await import('../src/event-log.ts')
  const sender = new EventLogReporter(options())
  sender.emit(event)
  sender.emit(event)
  expect(create).toHaveBeenCalledTimes(1)
  await sender.shutdown()

  const failure = onFailure()
  vi.spyOn(transport, 'createEventLogExporter').mockImplementation(() => { throw 'synthetic non-Error' })
  const failing = new EventLogReporter(options(failure))
  failing.emit(event)
  expect(failure).toHaveBeenCalledWith('Product telemetry pipeline failed to load', expect.objectContaining({ message: 'synthetic non-Error' }))
})

it('flushes a scheduled Session-log batch', async () => {
  const transport = await import('../src/transport.ts')
  const send = vi.fn<LogRecordExporter['export']>((_records, callback) => {
    callback({ code: ExportResultCode.SUCCESS })
  })
  vi.spyOn(transport, 'createLogExporter').mockReturnValue({
    export: send, forceFlush: async () => {}, shutdown: async () => {},
  })
  const { SessionLogReporter } = await import('../src/session-log.ts')
  const sender = new SessionLogReporter({ ...options(), processor: { scheduledDelayMillis: 5 } })
  sender.reportSessionLog(sessionRecord('scheduled'))
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(1) })
  await sender.shutdown()
})
