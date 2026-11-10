/** Ordinary events in a cancellable count-batched OTLP queue. */
import type { Attributes } from '@opentelemetry/api'
import { addAbortListener } from 'node:events'
import type { Logger, SeverityNumber } from '@opentelemetry/api-logs'
import type {
  BatchLogRecordProcessorOptions,
  LoggerProvider,
  LogRecordExporter,
} from '@opentelemetry/sdk-logs'
import { apiLogs, core, resources, sdkLogs } from './sdk.ts'
import type { SessionLogOptions } from './session-log.ts'
import { createEventLogExporter } from './event-transport.ts'
import type { LogExporterOptions } from './transport.ts'

/** Scalar values accepted by the collector's Arrow attributes map. */
export type OTelEventScalar = string | number | boolean

/** Explicitly selected analytics fields; object values may contain scalars only. */
export interface OTelEventRecord {
  /** Product/DA-owned event name. */
  eventName: string
  /** Human-readable summary; never a prompt, response, credential, or file contents. */
  body: string
  /** Event occurrence time in Unix milliseconds. Observation time is assigned on enqueue. */
  timestamp: number
  /** OTel severity; omitted values use INFO. */
  severityNumber?: SeverityNumber
  /** Business fields selected by the caller; no automatic device or account identity. */
  attributes?: Record<string, OTelEventScalar | Record<string, OTelEventScalar>>
}

/** Ordinary-event transport, resource, scope, and count-batching options. */
export interface EventLogOptions {
  exporter: LogExporterOptions
  resourceAttributes: Attributes
  scope: { name: string; version?: string }
  processor: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  onFailure: SessionLogOptions['onFailure']
}

/** One loaded ordinary-event queue and the transport it cancels on shutdown. */
interface EventLogPipeline {
  provider: LoggerProvider
  exporter: LogRecordExporter
  logger: Logger
  cancellation: AbortController
}

/** One caller-owned ordinary-event queue, independent of the Session-log queue. */
export class EventLogReporter {
  private readonly options: EventLogOptions
  private pipeline: EventLogPipeline | undefined
  private failed = false

  /** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  constructor(options: EventLogOptions) {
    this.options = options
  }

  /**
   * Enqueue caller-selected analytics fields without acknowledging delivery.
   * @param record - the ordinary event to report.
   */
  emit(record: OTelEventRecord): void {
    const pipeline = this.load()
    if (pipeline === undefined) return
    const { SeverityNumber } = apiLogs()
    const severityNumber = record.severityNumber ?? SeverityNumber.INFO
    pipeline.logger.emit({ ...record, observedTimestamp: Date.now(), severityNumber, severityText: SeverityNumber[severityNumber] })
  }

  /**
   * Drain the queue and release its transport, cancelling remaining exports when the caller aborts.
   * @param signal - optional shutdown deadline; abort discards pending exports and cancels retry waits.
   * @returns completion of SDK shutdown and transport cleanup.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    const pipeline = this.pipeline
    if (pipeline === undefined) return
    const abort = (): void => { pipeline.cancellation.abort(signal?.reason) }
    const listener = signal === undefined ? undefined : addAbortListener(signal, abort)
    if (signal?.aborted) abort()
    try { await pipeline.provider.shutdown() }
    finally {
      // SDK batch shutdown can reject before it releases the exporter.
      try { await pipeline.exporter.shutdown() }
      finally { listener?.[Symbol.dispose]() }
    }
  }

  private load(): EventLogPipeline | undefined {
    if (this.pipeline !== undefined) return this.pipeline
    if (this.failed) return undefined
    try {
      const { BatchLogRecordProcessor, LoggerProvider } = sdkLogs()
      const { ExportResultCode } = core()
      const cancellation = new AbortController()
      const exporter = createEventLogExporter(this.options.exporter, cancellation.signal)
      const provider = new LoggerProvider({
        resource: resources().resourceFromAttributes(this.options.resourceAttributes),
        processors: [new BatchLogRecordProcessor({
          ...this.options.processor,
          exporter: {
            export: (records, callback) => {
              exporter.export(records, (result) => {
                if (result.code !== ExportResultCode.SUCCESS) this.options.onFailure('Product telemetry export failed', result.error)
                callback(result)
              })
            },
            forceFlush: () => exporter.forceFlush(),
            shutdown: () => exporter.shutdown(),
          },
        })],
      })
      this.pipeline = { provider, exporter, logger: provider.getLogger(this.options.scope.name, this.options.scope.version), cancellation }
      return this.pipeline
    } catch (error) {
      this.failed = true
      const failure = error instanceof Error ? error : new Error(String(error))
      this.options.onFailure('Product telemetry pipeline failed to load', failure)
      return undefined
    }
  }
}
