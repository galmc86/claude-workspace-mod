import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WorkspaceChange, WorkspaceEntry, WorkspaceFolder, WorkspaceRoot } from '../types'

const PANE = 'workspace'
const CONFIG = '.claude/workspace.json'
const LOCAL_SETTINGS = '.claude/settings.local.json'

const roots = atom({ plugin: 'workspace', key: 'roots' } as const, [])
const note = atom({ plugin: 'workspace', key: 'note' } as const, '')
const closedRoots = atom({ plugin: 'workspace', key: 'closedRoots' } as const, [])
const openDirs = atom({ plugin: 'workspace', key: 'openDirs' } as const, [])
const listings = atom({ plugin: 'workspace', key: 'listings' } as const, {})

// The colors VS Code's Source Control gives each letter.
const CODE_COLORS: Record<string, 'warning' | 'success' | 'error' | 'suggestion'> = {
  M: 'warning',
  A: 'success',
  U: 'success',
  D: 'error',
  '!': 'error',
  R: 'suggestion',
}

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
  const changes: WorkspaceChange[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14)
    else if (line.startsWith('# branch.ab ')) {
      const [, a = '0', b = '0'] = /\+(\d+) -(\d+)/.exec(line) ?? []
      ahead = Number(a)
      behind = Number(b)
    } else if (line !== '' && !line.startsWith('#')) {
      const change = parseChange(line)
      if (change) changes.push(change)
    }
  }

  return { ...root, isMissing: false, branch, ahead, behind, changed: changes.length, changes: changes.slice(0, 100) }
}

// One `git status --porcelain=v2` entry line, in VS Code's letters.
function parseChange(line: string): WorkspaceChange | undefined {
  const fields = line.split(' ')
  const kind = fields[0]
  const xy = fields[1] ?? '..'
  const letter = xy[1] !== '.' ? xy[1] : xy[0]
  if (kind === '?') return { code: 'U', path: line.slice(2) }
  if (kind === 'u') return { code: '!', path: fields.slice(10).join(' ') }
  if (kind === '1') return { code: letter === 'T' ? 'M' : (letter ?? 'M'), path: fields.slice(8).join(' ') }
  if (kind === '2') return { code: 'R', path: fields.slice(9).join(' ').split('\t')[0] ?? '' }

  return undefined
}

async function listDir($: EngineInterface, path: string): Promise<WorkspaceEntry[]> {
  const entries = await $.fs.list(path).catch(() => [])

  return entries
    .filter(entry => entry.name !== '.git' && entry.kind !== 'other')
    .map(entry => ({ name: entry.name, isDir: entry.kind === 'dir' }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    .slice(0, 300)
}

async function toggleDir($: EngineInterface, path: string) {
  if ((await read($, openDirs)).includes(path)) {
    await update($, openDirs, list => list.filter(one => one !== path))
    return
  }
  const entries = await listDir($, path)
  await update($, listings, all => ({ ...all, [path]: entries }))
  await update($, openDirs, list => [...list, path])
}

// Files change as the model works: re-read every folder the tree shows.
async function relistOpenDirs($: EngineInterface) {
  const open = await read($, openDirs)
  const fresh = await Promise.all(open.map(async path => [path, await listDir($, path)] as const))
  await update($, listings, () => Object.fromEntries(fresh))
}

// `@path` in the prompt is how a file is mentioned, as VS Code's "Add to chat".
async function mention($: EngineInterface, root: WorkspaceRoot, relative: string) {
  const path = root.isPrimary ? relative : `${root.path}/${relative}`
  await $.prompt.fill({ text: `@${path} `, mode: 'insert' })
}

function describeRoot(root: WorkspaceRoot): string {
  if (root.isMissing) return 'missing (run /workspace sync)'
  const parts = [`⎇ ${root.branch ?? '?'}`]
  if (root.ahead || root.behind) parts.push(`↑${root.ahead} ↓${root.behind}`)
  parts.push(root.changed ? `${root.changed} changed` : 'clean')

  return parts.join(', ')
}

// The workspace this session is in; set again by every session.start.
let cwd = ''
let promptText = ''

async function load($: EngineInterface): Promise<WorkspaceRoot[]> {
  const folders = await readFolders($, cwd)
  const list: WorkspaceRoot[] = [
    { name: baseName(cwd), path: cwd, isPrimary: true, isMissing: false, ahead: 0, behind: 0, changed: 0, changes: [] },
    ...folders.map(one => ({
      name: one.name,
      path: resolvePath(cwd, one.path),
      repo: one.repo,
      isPrimary: false,
      isMissing: false,
      ahead: 0,
      behind: 0,
      changed: 0,
      changes: [],
    })),
  ]

  return Promise.all(list.map(root => gitStatus($, root)))
}

async function refresh($: EngineInterface): Promise<WorkspaceRoot[]> {
  const list = await load($)
  await update($, roots, () => list)
  promptText = composeSection(list)
  await relistOpenDirs($)

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
  } else if (spec.startsWith('/') && (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true') {
    return `${spec} is not on this machine: this session runs in a cloud container and cannot see your computer's folders. Add the project by its GitHub repo instead: /workspace add owner/repo`
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
    const closed = await read($, closedRoots)
    const open = await read($, openDirs)
    const listed = await read($, listings)
    const hasMissing = list.some(root => root.isMissing)
    const rows: JSX.Element[] = []
    const indent = (depth: number) => '  '.repeat(depth)

    // The folder's entries as rows, open folders drawn beneath themselves.
    const tree = (root: WorkspaceRoot, dir: string, relative: string, depth: number) => {
      for (const entry of listed[dir] ?? []) {
        const path = `${dir}/${entry.name}`
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        const isOpen = open.includes(path)
        rows.push(
          <Button
            key={`entry:${path}`}
            plain
            onPress={() => (entry.isDir ? toggleDir($, path) : mention($, root, rel))}
          >
            {indent(depth)}
            {entry.isDir ? (isOpen ? '▾ ' : '▸ ') : '  '}
            {entry.isDir ? <Text bold>{entry.name}</Text> : entry.name}
          </Button>,
        )
        if (entry.isDir && isOpen) tree(root, path, rel, depth + 1)
      }
    }

    for (const root of list) {
      const isOpen = !closed.includes(root.path)
      rows.push(
        <Button
          key={`root:${root.path}`}
          plain
          onPress={() =>
            update($, closedRoots, all =>
              isOpen ? [...all, root.path] : all.filter(one => one !== root.path),
            )
          }
        >
          <Text bold>
            {isOpen ? '▾ ' : '▸ '}
            {root.name}
            {root.isPrimary ? ' (primary)' : ''}
          </Text>{' '}
          <Text dimColor>{describeRoot(root)}</Text>
        </Button>,
      )
      if (!isOpen) continue
      if (root.isMissing) {
        rows.push(<Text color="warning">{indent(2)}Not on disk: press Clone missing or run /workspace sync</Text>)
        continue
      }

      if (root.changes.length > 0) {
        rows.push(<Text dimColor>{indent(1)}Changes ({root.changed})</Text>)
        for (const change of root.changes) {
          rows.push(
            <Button key={`change:${root.path}/${change.path}`} plain onPress={() => mention($, root, change.path)}>
              {indent(2)}
              <Text color={CODE_COLORS[change.code] ?? 'text'}>{change.code}</Text> {change.path}
            </Button>,
          )
        }
      }

      const isFilesOpen = open.includes(root.path)
      rows.push(
        <Button key={`files:${root.path}`} plain onPress={() => toggleDir($, root.path)}>
          {indent(1)}
          {isFilesOpen ? '▾ ' : '▸ '}
          <Text dimColor>Files</Text>
        </Button>,
      )
      if (isFilesOpen) tree(root, root.path, '', 2)
    }

    return (
      <Box flexDirection="column">
        {list.length < 2 && (
          <Text dimColor>Only this repo so far. Add one with /workspace add owner/repo</Text>
        )}
        {rows}
        {said !== '' && <Text dimColor>{said}</Text>}
        <Text dimColor>Press a file to mention it in the prompt.</Text>
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
