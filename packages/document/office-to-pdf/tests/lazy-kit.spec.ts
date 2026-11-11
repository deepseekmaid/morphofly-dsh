/** The LibreOffice kit loads on the first conversion, not when the provider mounts. */
import { Context } from '@deepseek-ai/cordis'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { expect, it, vi } from 'vitest'

const loader = vi.hoisted(() => ({ calls: 0, create: vi.fn<(options?: ConverterOptions) => Promise<Converter>>() }))
vi.mock('../src/kit.ts', () => ({
  loadKit: async () => { loader.calls++; return { createConverter: loader.create } },
}))

const request = {
  extension: 'docx' as const,
  priority: 'foreground' as const,
  source: { key: 'source' as never, version: 'v1', bytes: 4, read: async () => ({ bytes: new Uint8Array([80, 75, 3, 4]), version: 'v1' }) },
}

it('loads the kit on the first conversion, not at mount', async () => {
  const { default: OfficeToPdf } = await import('../src/index.ts')
  loader.create.mockImplementation(async () => ({
    backend: 'native',
    render: async ({ outputPath }: { outputPath: string }) => {
      await (await import('node:fs/promises')).writeFile(outputPath, '%PDF-1.7\n%%EOF\n')
      return { backend: 'native' as const, missingFonts: [] }
    },
    dispose: async () => {},
    renderImages: async () => { throw new Error('unexpected') },
    convert: async () => { throw new Error('unexpected') },
    recalculate: async () => { throw new Error('unexpected') },
  }))
  const ctx = new Context()
  try {
    await ctx.plugin(OfficeToPdf, { maxInputBytes: 4, maxOutputBytes: 1024 })
    expect(loader.calls).toBe(0)
    await ctx.officeToPdf.convert(request)
    expect(loader.calls).toBe(1)
    expect(loader.create).toHaveBeenCalledTimes(1)
  } finally {
    await ctx.fiber.dispose()
  }
}, 20_000)
