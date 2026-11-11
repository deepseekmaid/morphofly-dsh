#!/usr/bin/env node
/**
 * Installed CLI entry for disk launchers and embedded runtimes.
 * @module @deepseek-ai/dsh/installed-bin
 */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { RunCliOptions } from './bin.ts'

/** Young-generation size the launcher applies: 4 MiB per semi-space keeps a small heap at no measurable CPU cost. */
const SEMI_SPACE_FLAG = '--max-semi-space-size=4'

/**
 * V8 flags per `DSH_MEMORY_PROFILE`: `balanced` only shrinks the young
 * generation, while `low` also compiles for size and trades startup CPU for a
 * smaller heap.
 */
const MEMORY_PROFILES: Readonly<Record<string, readonly string[]>> = {
  balanced: [SEMI_SPACE_FLAG],
  low: [SEMI_SPACE_FLAG, '--optimize-for-size'],
}

/** Profile applied when `DSH_MEMORY_PROFILE` is unset. */
const DEFAULT_MEMORY_PROFILE = 'balanced'

/** Commands that only print or dump without booting a profile; re-execution would add latency for no heap gain. */
const LIGHT_COMMANDS: ReadonlySet<string> = new Set([
  '--version', '-V', '--help', '-h', '--dump-config', '--dump-config-schema',
])

/** An explicit young-generation choice outranks the launcher's default. */
const SEMI_SPACE_CHOICE = /--max-semi-space-size/

/**
 * Compute the re-executed argument list that applies launch tuning.
 *
 * The installed launcher owns its process, so it can replace its image with the
 * same executable plus the tuned flags before the plugin module tree loads.
 *
 * @param execArgv - Node flags already applied to this process.
 * @param argv - The full `process.argv` of this process.
 * @param env - Launch environment, honoring an explicit opt-out and profile.
 * @param execve - The runtime's `process.execve`, absent on unsupported runtimes.
 * @returns The argument list for `process.execve`, or `undefined` when no re-execution is needed.
 * @throws When `DSH_MEMORY_PROFILE` names no known profile.
 */
export function tunedExecArgv(
  execArgv: readonly string[],
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  execve: typeof process.execve | undefined,
): string[] | undefined {
  if (env.DSH_DISABLE_GC_TUNING !== undefined) return undefined
  const profile = env.DSH_MEMORY_PROFILE ?? DEFAULT_MEMORY_PROFILE
  const flags = MEMORY_PROFILES[profile]
  if (flags === undefined) {
    throw new Error(
      `dsh: DSH_MEMORY_PROFILE must be one of ${Object.keys(MEMORY_PROFILES).join(', ')}, received ${JSON.stringify(profile)}`,
    )
  }
  if (execve === undefined) return undefined
  if (flags.every(flag => execArgv.includes(flag))) return undefined
  if ((env.NODE_OPTIONS ?? '').includes('--max-semi-space-size')) return undefined
  if (execArgv.some(argument => SEMI_SPACE_CHOICE.test(argument) && argument !== SEMI_SPACE_FLAG)) return undefined
  if (argv.slice(2).some(argument => LIGHT_COMMANDS.has(argument))) return undefined
  return [process.execPath, ...flags, ...execArgv.filter(argument => !flags.includes(argument)), ...argv.slice(1)]
}

/**
 * Run the CLI in the importing carrier's module tree.
 * @param options - Installation-owned runtime options.
 * @returns Settlement of the selected command.
 */
export async function runCli(options?: RunCliOptions): Promise<void> {
  const cli = await import('./bin.ts')
  await cli.runCli(options)
}

if (import.meta.main) {
  const execve = process.execve?.bind(process)
  let tuned: string[] | undefined
  try {
    tuned = tunedExecArgv(process.execArgv, process.argv, process.env, execve)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  if (tuned !== undefined && execve !== undefined) {
    try {
      execve(process.execPath, tuned, process.env)
    } catch {
      // process.execve refused (unsupported carrier or sandbox): keep the default heap policy.
    }
  }
  // Windows ESM can retain an 8.3 spelling while profile resolution expands it.
  const entry = process.platform === 'win32' ? pathToFileURL(realpathSync.native(import.meta.filename)).href : import.meta.url
  if (entry === import.meta.url) await runCli()
  else {
    const canonical = await import(entry) as typeof import('./installed-bin.ts')
    await canonical.runCli()
  }
}
