/** Purpose: Mark process projection events as ignorable in an explicit session log.
 * Example: run without --apply to inspect counts; --apply preserves a backup and atomically replaces the file. */
import { constants, copyFile, chmod, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

const EVENT_TYPE = 'agent-test/processes'

function usage() {
  return 'usage: node scripts/migrate-session-agent-test-processes.mjs [--apply] /absolute/path/session.jsonl.zstd'
}

function waitFor(child, label) {
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  return new Promise((resolveWait, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveWait()
      else reject(new Error(`${label} failed (${signal ?? String(code)}): ${stderr.trim()}`))
    })
  })
}

async function compressFrame(text, label) {
  const child = spawn('zstd', ['-q', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const chunks = []
  child.stdout.on('data', chunk => { chunks.push(chunk) })
  const done = waitFor(child, label)
  child.stdin.end(text)
  await done
  return Buffer.concat(chunks)
}

function sameFileState(left, right) {
  return left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

const args = process.argv.slice(2)
const apply = args[0] === '--apply'
const pathArg = apply ? args[1] : args[0]
if (pathArg === undefined || args.length !== (apply ? 2 : 1)) throw new Error(usage())

const target = resolve(pathArg)
if (basename(target) !== 'session.jsonl.zstd') {
  throw new Error('migration target must be an explicit session.jsonl.zstd file')
}

const before = await stat(target)
if (!before.isFile()) throw new Error('migration target is not a regular file')

const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, '')
const temporary = `${target}.migration-${process.pid}-${crypto.randomUUID()}.tmp`
const backup = `${target}.before-${stamp}.bak`
const decoder = spawn('zstd', ['-q', '-dc', '--', target], { stdio: ['ignore', 'pipe', 'pipe'] })

let lines = 0
let matched = 0
let migrated = 0
const outputLines = []
try {
  const decoderDone = waitFor(decoder, 'zstd decode')
  const input = createInterface({ input: decoder.stdout, crlfDelay: Infinity })
  for await (const line of input) {
    lines += 1
    let output = line
    if (line.length > 0) {
      let value
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`session log contains invalid JSON at line ${lines}`)
      }
      if (value !== null && typeof value === 'object' && value.type === EVENT_TYPE) {
        matched += 1
        if (value.ignorable !== true) {
          value.ignorable = true
          output = JSON.stringify(value)
          migrated += 1
        }
      }
      if (lines === 1 && value.type !== 'session') {
        throw new Error('session log first line is not a session header')
      }
    }
    if (apply) outputLines.push(output)
  }
  await decoderDone

  const afterScan = await stat(target)
  if (!sameFileState(before, afterScan)) {
    throw new Error('session log changed while migration was scanning; refusing to replace it')
  }

  if (!apply || migrated === 0) {
    console.log(JSON.stringify({
      status: apply ? 'unchanged' : 'dry-run',
      target,
      lines,
      matchedEvents: matched,
      pendingEvents: migrated,
    }))
    process.exitCode = 0
  } else {
    if (outputLines.length < 2) throw new Error('session log has no event body')
    const [header, ...events] = outputLines
    const [headerFrame, eventFrame] = await Promise.all([
      compressFrame(`${header}\n`, 'zstd header encode'),
      compressFrame(`${events.join('\n')}\n`, 'zstd event encode'),
    ])
    const temporaryHandle = await open(temporary, 'wx', 0o600)
    try {
      await temporaryHandle.writeFile(Buffer.concat([headerFrame, eventFrame]))
      await temporaryHandle.sync()
    } finally {
      await temporaryHandle.close()
    }
    await copyFile(target, backup, constants.COPYFILE_EXCL)
    await chmod(backup, before.mode)
    const beforeReplace = await stat(target)
    if (!sameFileState(before, beforeReplace)) {
      await rm(temporary, { force: true })
      throw new Error(`session log changed before replacement; original preserved and backup retained at ${backup}`)
    }
    await chmod(temporary, before.mode)
    await rename(temporary, target)
    const directoryHandle = await open(dirname(target), 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
    console.log(JSON.stringify({
      status: 'migrated',
      target,
      backup,
      lines,
      matchedEvents: matched,
      migratedEvents: migrated,
    }))
  }
} catch (error) {
  decoder.kill('SIGTERM')
  await rm(temporary, { force: true })
  throw error
}
