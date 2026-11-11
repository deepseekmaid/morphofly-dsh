/** Launch memory tuning re-executes the installed launcher with a smaller V8 young generation. */
import { describe, expect, it } from 'vitest'
import { tunedExecArgv } from '../src/installed-bin.ts'

const execve: typeof process.execve = () => { throw new Error('unexpected process.execve') }
const argv = ['/usr/bin/node', '/app/apps/cli/lib/bin.js', 'web', '--port', '0']

describe('tunedExecArgv', () => {
  it('applies the tuned flag ahead of the script when the process is untouched', () => {
    expect(tunedExecArgv([], argv, {}, execve)).toEqual([
      process.execPath, '--max-semi-space-size=4', '/app/apps/cli/lib/bin.js', 'web', '--port', '0',
    ])
  })

  it('preserves existing Node flags between the tuned flag and the script', () => {
    const tuned = tunedExecArgv(['--enable-source-maps'], argv, {}, execve)
    expect(tuned?.[1]).toBe('--max-semi-space-size=4')
    expect(tuned).toContain('--enable-source-maps')
  })

  it('leaves an already tuned process alone', () => {
    expect(tunedExecArgv(['--max-semi-space-size=4'], argv, {}, execve)).toBeUndefined()
    expect(tunedExecArgv(['--max-semi-space-size=4', '--optimize-for-size'], argv, { DSH_MEMORY_PROFILE: 'low' }, execve))
      .toBeUndefined()
  })

  it('completes the low profile after the balanced re-execution', () => {
    expect(tunedExecArgv(['--max-semi-space-size=4'], argv, { DSH_MEMORY_PROFILE: 'low' }, execve)).toEqual([
      process.execPath, '--max-semi-space-size=4', '--optimize-for-size', '/app/apps/cli/lib/bin.js', 'web', '--port', '0',
    ])
  })

  it('defers to an explicit young-generation choice', () => {
    expect(tunedExecArgv(['--max-semi-space-size=8'], argv, {}, execve)).toBeUndefined()
    expect(tunedExecArgv([], argv, { NODE_OPTIONS: '--max-semi-space-size=8' }, execve)).toBeUndefined()
  })

  it('honors the opt-out switch', () => {
    expect(tunedExecArgv([], argv, { DSH_DISABLE_GC_TUNING: '1' }, execve)).toBeUndefined()
  })

  it('adds size-optimized compilation under the low memory profile', () => {
    expect(tunedExecArgv([], argv, { DSH_MEMORY_PROFILE: 'low' }, execve)).toEqual([
      process.execPath, '--max-semi-space-size=4', '--optimize-for-size', '/app/apps/cli/lib/bin.js', 'web', '--port', '0',
    ])
  })

  it('rejects an unknown memory profile', () => {
    expect(() => tunedExecArgv([], argv, { DSH_MEMORY_PROFILE: 'tiny' }, execve))
      .toThrow('dsh: DSH_MEMORY_PROFILE must be one of balanced, low, received "tiny"')
  })

  it('leaves print-only commands on the default heap policy', () => {
    expect(tunedExecArgv([], ['/usr/bin/node', '/app/bin.js', '--version'], {}, execve)).toBeUndefined()
    expect(tunedExecArgv([], ['/usr/bin/node', '/app/bin.js', '--profile', 'web', '--dump-config'], {}, execve)).toBeUndefined()
  })

  it('skips runtimes without process.execve', () => {
    expect(tunedExecArgv([], argv, {}, undefined)).toBeUndefined()
  })
})
