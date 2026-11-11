/** Explicit OTLP JSON transport for feedback-authorized Session logs. */
import type { ExporterMetrics, OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { exporterBase, exporterBaseNodeHttp, otlpTransformer } from './sdk.ts'

/** `otel.component.type` reported by OTLP HTTP log exporter self-observability metrics. */
const OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE = 'otlp_http_log_exporter'

/**
 * Collector and SDK HTTP settings accepted by this package's log exporters.
 *
 * `OTLPExporterConfigBase.selfObsMeterProvider` is excluded: every channel here
 * passes no meter provider to the exporter metrics recorder, which stays noop.
 */
export type LogExporterOptions = Omit<OTLPExporterNodeConfigBase, 'selfObsMeterProvider'> & {
  /** Full HTTP(S) logs destination. */
  url: string
}

/**
 * Create an SDK JSON exporter without inheriting another collector's headers or TLS identity.
 * @param options - explicit endpoint, headers, agent, and SDK transport settings.
 * @returns the exporter owned by one independent log pipeline.
 */
export function createLogExporter(options: LogExporterOptions): LogRecordExporter {
  const { OTLPExporterBase } = exporterBase()
  const { createOtlpHttpExportDelegate } = exporterBaseNodeHttp()
  const { JsonLogsSerializer, LogsExporterMetricsHelper } = otlpTransformer()
  return new OTLPExporterBase(createOtlpHttpExportDelegate(
    logTransportOptions(options), JsonLogsSerializer, OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, undefined))
}

/**
 * Create one log exporter's self-observability metrics; without a meter provider they record nothing.
 * @param url - collector endpoint recorded as the metrics server address and port.
 * @returns the metrics recorder required by an OTLP HTTP log export delegate.
 */
export function createLogExporterMetrics(url: string): ExporterMetrics<ReadableLogRecord[]> {
  const { createOtlpHttpExporterMetrics } = exporterBaseNodeHttp()
  const { LogsExporterMetricsHelper } = otlpTransformer()
  return createOtlpHttpExporterMetrics(OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, url, undefined)
}

/**
 * Resolve collector-local headers and agents with shared SDK timeout and compression defaults.
 * @param options - explicit endpoint and SDK HTTP settings.
 * @returns resolved transport settings without ambient credentials.
 */
export function logTransportOptions(
  options: LogExporterOptions,
): Parameters<ReturnType<typeof exporterBaseNodeHttp>['createOtlpHttpExportDelegate']>[0] {
  const { mergeOtlpSharedConfigurationWithDefaults, getSharedConfigurationDefaults } = exporterBase()
  const { getSharedConfigurationFromEnvironment, httpAgentFactoryFromOptions } = exporterBaseNodeHttp()
  const shared = mergeOtlpSharedConfigurationWithDefaults(options, getSharedConfigurationFromEnvironment('LOGS'), getSharedConfigurationDefaults())
  return {
    ...shared,
    url: options.url,
    headers: async () => ({
      'Content-Type': 'application/json',
      ...typeof options.headers === 'function' ? await options.headers() : options.headers,
    }),
    // An agent factory owns the returned agent, including its keepAlive setting.
    agentFactory: typeof options.httpAgentOptions === 'function' ? options.httpAgentOptions
      : httpAgentFactoryFromOptions({ keepAlive: options.keepAlive ?? true, ...options.httpAgentOptions }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  }
}
