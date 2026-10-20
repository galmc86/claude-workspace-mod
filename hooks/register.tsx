import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WorkspaceFolder, WorkspaceRoot } from '../types'

const PANE = 'workspace'
const CONFIG = '.claude/workspace.json'
const LOCAL_SETTINGS = '.claude/settings.local.json'

const roots = atom({ plugin: 'workspace', key: 'roots' } as const, [])
const note = atom({ plugin: 'workspace', key: 'note' } as const, '')

const USAGE = [
  'Usage:',
  '  /workspace                       show the workspace pane',
  '  /workspace add <path> [name]     add a local folder (relative to this repo, or absolute)',
  '  /workspace add <owner/repo> [name]  add a GitHub repo, cloned next to this one when missing',
  '  /workspace remove <name>         drop a folder from the workspace (files stay on disk)',
  '  /workspace sync                  clone missing folders and refresh status',
  '  /workspace status                print every repo\'s branch and changes',
].join('\n')

// Paths are joined by hand: the module has no Node `path`.
function resolvePath(base: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${base}/${path}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return `/${out.join('/')}`
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

function isRepoSpec(text: string): boolean {
  return /^(https?:\/\/|git@)/.test(text) || /^[\w.-]+\/[\w.-]+$/.test(text)
}

function repoName(spec: string): string {
  return baseName(spec).replace(/\.git$/, '')
}

function cloneUrl(spec: string): string {
  return /^(https?:\/\/|git@)/.test(spec) ? spec : `https://github.com/${spec}.git`
}

async function readJson(
  $: EngineInterface,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  try {
    return JSON.parse(await $.fs.read(path)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function readFolders($: EngineInterface, cwd: string): Promise<WorkspaceFolder[]> {
  const config = await readJson($, `${cwd}/${CONFIG}`)
  const folders = Array.isArray(config?.folders) ? config.folders : []

  return folders.filter(
    (one): one is WorkspaceFolder =>
      typeof one === 'object' && one !== null && typeof one.path === 'string',
  ).map(one => ({ ...one, name: one.name || baseName(one.path) }))
}

async function writeFolders($: EngineInterface, cwd: string, folders: WorkspaceFolder[]) {
  const config = (await readJson($, `${cwd}/${CONFIG}`)) ?? {}
  await $.fs.write(`${cwd}/${CONFIG}`, `${JSON.stringify({ ...config, folders }, null, 2)}\n`)
}

// Grants the session access to every folder the way `/add-dir` does: the
// engine re-reads a changed settings file, so the new folders apply at once.
async function syncAdditionalDirectories(
  $: EngineInterface,
  cwd: string,
  wanted: string[],
  dropped: string[],
) {
  const settings = (await readJson($, `${cwd}/${LOCAL_SETTINGS}`)) ?? {}
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>
  const current = Array.isArray(permissions.additionalDirectories)
    ? (permissions.additionalDirectories as string[])
    : []
  const next = [...new Set([...current.filter(dir => !dropped.includes(dir)), ...wanted])]
  if (next.length === current.length && next.every(dir => current.includes(dir))) return

  await $.fs.write(
    `${cwd}/${LOCAL_SETTINGS}`,
    `${JSON.stringify({ ...settings, permissions: { ...permissions, additionalDirectories: next } }, null, 2)}\n`,
  )
}

async function gitStatus($: EngineInterface, root: WorkspaceRoot): Promise<WorkspaceRoot> {
  if (!(await $.fs.exists(root.path))) return { ...root, isMissing: true }

  const { exitCode, stdout } = await $.process.run(
    ['git', '-C', root.path, 'status', '--porcelain=v2', '--branch'],
    { timeoutMs: 10_000 },
  ).catch(() => ({ exitCode: 1, stdout: '' }))
  if (exitCode !== 0) return { ...root, isMissing: false, branch: '(not a git repo)' }

  let branch: string | undefined
  let ahead = 0
  let behind = 0
  let changed = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14)
    else if (line.startsWith('# branch.ab ')) {
      const [, a = '0', b = '0'] = /\+(\d+) -(\d+)/.exec(line) ?? []
      ahead = Number(a)
      behind = Number(b)
    } else if (line !== '' && !line.startsWith('#')) changed += 1
  }

  return { ...root, isMissing: false, branch, ahead, behind, changed }
}

function describeRoot(root: WorkspaceRoot): string {
  if (root.isMissing) return 'missing (run /workspace sync)'
  const parts = [root.branch ?? '?']
  if (root.ahead || root.behind) parts.push(`+${root.ahead} -${root.behind}`)
  parts.push(root.changed ? `${root.changed} changed` : 'clean')

  return parts.join(', ')
}

// The workspace this session is in; set again by every session.start.
let cwd = ''
let promptText = ''

async function load($: EngineInterface): Promise<WorkspaceRoot[]> {
  const folders = await readFolders($, cwd)
  const list: WorkspaceRoot[] = [
    { name: baseName(cwd), path: cwd, isPrimary: true, isMissing: false, ahead: 0, behind: 0, changed: 0 },
    ...folders.map(one => ({
      name: one.name,
      path: resolvePath(cwd, one.path),
      repo: one.repo,
      isPrimary: false,
      isMissing: false,
      ahead: 0,
      behind: 0,
      changed: 0,
    })),
  ]

  return Promise.all(list.map(root => gitStatus($, root)))
}

async function refresh($: EngineInterface): Promise<WorkspaceRoot[]> {
  const list = await load($)
  await update($, roots, () => list)
  promptText = composeSection(list)

  return list
}

// Only what rarely changes goes in the system prompt (names, paths, repos),
// so the prompt cache survives a turn that edits files.
function composeSection(list: WorkspaceRoot[]): string {
  if (list.length < 2) return ''
  const lines = list.map(root => {
    const tags = [root.isPrimary ? 'primary, the session cwd' : '', root.repo ?? '', root.isMissing ? 'NOT ON DISK' : '']
      .filter(Boolean)
      .join('; ')

    return `- ${root.name}: ${root.path}${tags ? ` (${tags})` : ''}`
  })

  return [
    '# Multi-repo workspace',
    'This session works on a workspace of related repositories, like a VS Code multi-root workspace. Treat them as one project:',
    ...lines,
    '',
    '- When searching for code, a definition or a usage, search every root, not only the cwd: pass each root as the path to Grep/Glob, or name the root in Bash commands.',
    '- Use absolute paths for files outside the cwd. Run git per repo with `git -C <root> ...`; never assume the cwd is the repo you are changing.',
    '- A change that crosses repos (an API and its client, a shared model) is made in every repo it touches, and each repo is committed, on its own branch, and pushed separately. Say which repos you changed.',
    '- A root marked NOT ON DISK must be cloned first: in a cloud session attach it with the add_repo tool, otherwise ask the person to run /workspace sync.',
  ].join('\n')
}

async function add($: EngineInterface, spec: string, name?: string): Promise<string> {
  const folders = await readFolders($, cwd)
  const asPath = resolvePath(cwd, spec)
  const isLocal = (await $.fs.exists(asPath)) && (await $.fs.stat(asPath)).kind === 'dir'

  let folder: WorkspaceFolder
  let message: string
  if (isLocal) {
    folder = { name: name ?? baseName(asPath), path: spec.startsWith('/') ? spec : spec.replace(/\/+$/, '') }
    message = `Added ${folder.name} (${asPath}).`
  } else if (isRepoSpec(spec)) {
    folder = { name: name ?? repoName(spec), path: `../${repoName(spec)}`, repo: spec }
    message = await clone($, folder)
  } else {
    return `${spec} is neither a folder nor a repo (owner/repo or a git URL).`
  }

  if (folders.some(one => one.name === folder.name)) return `A folder named ${folder.name} is already in the workspace.`
  if (resolvePath(cwd, folder.path) === cwd) return 'That is the primary repo; it is always in the workspace.'

  await writeFolders($, cwd, [...folders, folder])
  await syncAdditionalDirectories($, cwd, [resolvePath(cwd, folder.path)], [])

  return message
}

async function clone($: EngineInterface, folder: WorkspaceFolder): Promise<string> {
  const target = resolvePath(cwd, folder.path)
  if (await $.fs.exists(target)) return `Added ${folder.name} (${target}).`
  if (!folder.repo) return `${folder.name} is missing at ${target} and names no repo to clone.`

  const { exitCode, stderr } = await $.process.run(
    ['git', 'clone', cloneUrl(folder.repo), target],
    { timeoutMs: 600_000 },
  ).catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }))

  return exitCode === 0
    ? `Cloned ${folder.repo} into ${target}.`
    : `Could not clone ${folder.repo} into ${target}: ${stderr.trim().split('\n').pop()}. In a cloud session, ask Claude to attach it with add_repo, then run /workspace sync.`
}

async function remove($: EngineInterface, name: string): Promise<string> {
  const folders = await readFolders($, cwd)
  const gone = folders.find(one => one.name === name)
  if (!gone) return `No folder named ${name} in the workspace.`

  await writeFolders($, cwd, folders.filter(one => one !== gone))
  await syncAdditionalDirectories($, cwd, [], [resolvePath(cwd, gone.path)])

  return `Removed ${name} from the workspace; its files are untouched.`
}

async function sync($: EngineInterface): Promise<string> {
  const folders = await readFolders($, cwd)
  const lines = await Promise.all(folders.map(one => clone($, one)))
  await syncAdditionalDirectories($, cwd, folders.map(one => resolvePath(cwd, one.path)), [])

  return lines.length ? lines.join('\n') : 'The workspace has no folders yet. /workspace add <path|owner/repo>'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'workspace',
      description: 'Work across several related repos in this session',
      argumentHint: '[add <path|owner/repo> [name] | remove <name> | sync | status]',
    })
    const list = await refresh($)
    if (list.length > 1) {
      await syncAdditionalDirectories($, cwd, list.filter(one => !one.isPrimary).map(one => one.path), [])
      $.ui.status(`workspace: ${list.length} repos`)
    }

    return next(e)
  })

  on('command.run', { command: 'workspace' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    let text: string
    if (verb === '' || verb === 'list' || verb === 'show') {
      await $.ui.open({ id: PANE, title: 'Workspace' })
      const list = await refresh($)

      return { text: list.map(root => `${root.name}: ${root.path} (${describeRoot(root)})`).join('\n') }
    }
    if (verb === 'status') {
      const list = await refresh($)

      return { text: list.map(root => `${root.name}: ${describeRoot(root)}`).join('\n') }
    }
    if (verb === 'add' && rest[0]) text = await add($, rest[0], rest[1])
    else if (verb === 'remove' && rest[0]) text = await remove($, rest[0])
    else if (verb === 'sync') text = await sync($)
    else return { text: USAGE }

    const list = await refresh($)
    $.ui.status(list.length > 1 ? `workspace: ${list.length} repos` : undefined)
    await update($, note, () => text)

    return {
      text,
      context: [`The workspace now holds: ${list.map(root => `${root.name} at ${root.path}`).join('; ')}.`],
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!promptText) return composed

    return { sections: [...composed.sections, { id: 'workspace:roots', text: promptText, scope: 'session' }] }
  })

  // Branches and changed counts move as the model works: refresh once a turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (cwd) await refresh($)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, roots)
    const said = await read($, note)
    const hasMissing = list.some(root => root.isMissing)

    return (
      <Box flexDirection="column">
        {list.length < 2 && (
          <Text dimColor>Only this repo so far. Add one with /workspace add ../other-repo or /workspace add owner/repo</Text>
        )}
        {list.map(root => (
          <Box flexDirection="column" key={root.path}>
            <Text bold={root.isPrimary}>
              {root.isPrimary ? '* ' : '  '}
              {root.name}
            </Text>
            <Text dimColor={!root.isMissing && root.changed === 0}>    {describeRoot(root)}</Text>
          </Box>
        ))}
        {said !== '' && <Text dimColor>{said}</Text>}
        <Box>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          {hasMissing && (
            <Button
              key="sync"
              label="Clone missing"
              onPress={async () => {
                const text = await sync($)
                await update($, note, () => text)
                await refresh($)
              }}
            />
          )}
        </Box>
      </Box>
    )
  })
}
