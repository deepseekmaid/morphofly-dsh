/** Conversion-only LibreOffice kit import; profile boot never loads its native and font tree. */

/** The kit module as the provider uses it. */
export type KitModule = typeof import('@deepseek-ai/libreoffice-kit')

/* v8 ignore start -- unit tests replace this loader; the real kit needs an installed engine. */
/**
 * Load the LibreOffice kit on demand.
 * @returns the kit module, imported once and cached by the module system.
 */
export function loadKit(): Promise<KitModule> {
  return import('@deepseek-ai/libreoffice-kit')
}
/* v8 ignore stop */
