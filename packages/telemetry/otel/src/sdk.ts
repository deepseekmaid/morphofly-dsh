/** Lazily required OTel SDK modules; boot pays for none of them until a channel reports. */
import { createRequire } from 'node:module'

type ApiLogs = typeof import('@opentelemetry/api-logs')
type Core = typeof import('@opentelemetry/core')
type ExporterBase = typeof import('@opentelemetry/otlp-exporter-base')
type ExporterBaseNodeHttp = typeof import('@opentelemetry/otlp-exporter-base/node-http')
type OtlpTransformer = typeof import('@opentelemetry/otlp-transformer')
type Resources = typeof import('@opentelemetry/resources')
type SdkLogs = typeof import('@opentelemetry/sdk-logs')
type Got = typeof import('got')

// The SDK packages are CommonJS, so one synchronous `require` per module keeps the
// exported channel API synchronous while leaving the OTLP tree out of module boot.
const requireFromHere = createRequire(import.meta.url)

let apiLogsModule: ApiLogs | undefined
let coreModule: Core | undefined
let exporterBaseModule: ExporterBase | undefined
let exporterBaseNodeHttpModule: ExporterBaseNodeHttp | undefined
let transformerModule: OtlpTransformer | undefined
let resourcesModule: Resources | undefined
let sdkLogsModule: SdkLogs | undefined
let gotModule: Got | undefined

/**
 * Load the log API that defines severity values.
 * @returns the cached `@opentelemetry/api-logs` module.
 */
export function apiLogs(): ApiLogs {
  return apiLogsModule ??= requireFromHere('@opentelemetry/api-logs') as ApiLogs
}

/**
 * Load SDK result codes and shared helpers.
 * @returns the cached `@opentelemetry/core` module.
 */
export function core(): Core {
  return coreModule ??= requireFromHere('@opentelemetry/core') as Core
}

/**
 * Load the exporter base classes and shared OTLP configuration helpers.
 * @returns the cached `@opentelemetry/otlp-exporter-base` module.
 */
export function exporterBase(): ExporterBase {
  return exporterBaseModule ??= requireFromHere('@opentelemetry/otlp-exporter-base') as ExporterBase
}

/**
 * Load the Node HTTP OTLP delegate and agent factory.
 * @returns the cached `@opentelemetry/otlp-exporter-base/node-http` module.
 */
export function exporterBaseNodeHttp(): ExporterBaseNodeHttp {
  return exporterBaseNodeHttpModule ??= requireFromHere('@opentelemetry/otlp-exporter-base/node-http') as ExporterBaseNodeHttp
}

/**
 * Load the JSON log serializer used for per-record byte accounting and requests.
 * @returns the cached `@opentelemetry/otlp-transformer` module.
 */
export function otlpTransformer(): OtlpTransformer {
  return transformerModule ??= requireFromHere('@opentelemetry/otlp-transformer') as OtlpTransformer
}

/**
 * Load the resource attribute helper.
 * @returns the cached `@opentelemetry/resources` module.
 */
export function resources(): Resources {
  return resourcesModule ??= requireFromHere('@opentelemetry/resources') as Resources
}

/**
 * Load the log provider and batching processor classes.
 * @returns the cached `@opentelemetry/sdk-logs` module.
 */
export function sdkLogs(): SdkLogs {
  return sdkLogsModule ??= requireFromHere('@opentelemetry/sdk-logs') as SdkLogs
}

/**
 * Load the cancellable HTTP client used by ordinary-event exports.
 * @returns the cached `got` module; the instance is its default export.
 */
export function got(): Got {
  return gotModule ??= requireFromHere('got') as Got
}
