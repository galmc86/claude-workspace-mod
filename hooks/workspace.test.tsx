import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'workspace',
  component: 'Pane',
  requestId: 'workspace',
  props: {
    title: 'Workspace',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// How a person typing `/workspace ...` at the prompt reaches the command.
function typed(args: string) {
  return {
    command: 'workspace',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  } as const
}

test('add, list and remove a sibling repo, on every surface', async ($, on) => {
  // A fake disk: the primary repo and one sibling, both git repos.
  const files = new Map<string, string>()
  const dirs = new Set(['/work/app', '/work/api'])

  on('command.register', () => ({ value: { command: 'workspace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.stat', (_, e) => ({
    value: { kind: dirs.has(e.path) ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false },
  }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: e.path === '/work/api'
      ? [
          { name: '.git', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: 'README.md', kind: 'file', size: 0, mtimeMs: 0, isLink: false },
          { name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        ]
      : [{ name: 'x.ts', kind: 'file', size: 0, mtimeMs: 0, isLink: false }],
  }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.status', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'true' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[2] === '/work/api'
        ? '# branch.head feature\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b src/x.ts\n'
        : '# branch.head main\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  const added = await $.command.run(typed('add ../api'))
  expect(added.text).toBe('Added api (/work/api).')
  expect(JSON.parse(files.get('/work/app/.claude/workspace.json') ?? '{}')).toEqual({
    folders: [{ name: 'api', path: '../api' }],
  })
  expect(
    JSON.parse(files.get('/work/app/.claude/settings.local.json') ?? '{}').permissions
      .additionalDirectories,
  ).toEqual(['/work/api'])

  const status = await $.command.run(typed('status'))
  expect(status.text).toBe('app: ⎇ main, clean\napi: ⎇ feature, ↑2 ↓0, 1 changed')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /feature/ }))?.text).toBe('⎇ feature, ↑2 ↓0, 1 changed')
    expect(await ui.find({ key: 'change:/work/api/src/x.ts' })).toBeDefined()

    // Open the api repo's files, then its src folder, then mention a file.
    await ui.press({ key: 'files:/work/api' })
    expect(await ui.find({ key: 'entry:/work/api/.git' })).toBeUndefined()
    await ui.press({ key: 'entry:/work/api/src' })
    await ui.press({ key: 'entry:/work/api/src/x.ts' })
    expect(filled.pop()).toBe('@/work/api/src/x.ts ')
    await ui.press({ key: 'entry:/work/api/src' })
    expect(await ui.find({ key: 'entry:/work/api/src/x.ts' })).toBeUndefined()
    await ui.press({ key: 'files:/work/api' })
    expect(await ui.find({ key: 'entry:/work/api/src' })).toBeUndefined()

    // Collapsing a repo hides its changes.
    await ui.press({ key: 'root:/work/api' })
    expect(await ui.find({ key: 'change:/work/api/src/x.ts' })).toBeUndefined()
    await ui.press({ key: 'root:/work/api' })
    await ui.unmount()
  }

  const fromMac = await $.command.run(typed('add /Users/me/projects/shelter-finder'))
  expect(fromMac.text).toMatch(/^\/Users\/me\/projects\/shelter-finder is not on this machine/)

  const removed = await $.command.run(typed('remove api'))
  expect(removed.text).toBe('Removed api from the workspace; its files are untouched.')
  expect(
    JSON.parse(files.get('/work/app/.claude/settings.local.json') ?? '{}').permissions
      .additionalDirectories,
  ).toEqual([])
})
