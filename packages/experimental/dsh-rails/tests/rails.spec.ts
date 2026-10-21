import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as rails from '../src/index.js'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
  tempDirs.push(dir)
  return dir
}

type RunSkillValue = {
  value: {
    repoId: string
    skillName: string
    targetFile: string
    mode: string
    subagentId?: string
    stopReason?: string
    output?: string
    outputFile?: string
    reportFile?: string
    stdout?: string
    stderr?: string
  }
}

function fakeAgent(id = 'fake-agent'): Agent {
  return { id } as unknown as Agent
}

function fakeSubagentRuntime(outcome: { output: { type: 'text'; text: string }[]; stopReason: string }): unknown {
  return {
    startActivation: vi.fn().mockResolvedValue({
      childId: 'fake-child-id',
      result: Promise.resolve(outcome),
      dispose: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

async function setup(_home: string, config: rails.Config = {}, subagents?: unknown): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  if (subagents !== undefined) ctx.provide('subagents', subagents)
  await ctx.plugin(rails, config)
  return ctx
}

describe('dsh-rails', () => {
  it('registers rails_list_repos and rails_clone_repo tools', async () => {
    const home = await tempDir('rails')
    const ctx = await setup(home, {
      repos: [{ id: 'rails-template', name: 'Rails Template', githubUrl: 'https://example.com/repo.git' }],
    })

    expect(ctx.tools.get('rails_list_repos')).toBeDefined()
    expect(ctx.tools.get('rails_clone_repo')).toBeDefined()
  })

  it('lists configured repos', async () => {
    const home = await tempDir('rails')
    const ctx = await setup(home, {
      repos: [{ id: 'rails-template', name: 'Rails Template', githubUrl: 'https://example.com/repo.git' }],
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('rails-list-1'),
      name: 'rails_list_repos',
      arguments: {},
    })
    expect('value' in result).toBe(true)
    const value = (result as { value: { repos: { id: string }[] } }).value
    expect(value.repos).toHaveLength(1)
    expect(value.repos[0]!.id).toBe('rails-template')
  })

  it('discovers skills from cloned repo structure', async () => {
    const home = await tempDir('rails')
    const repoDir = join(home, 'repos', 'rails-template')
    const skillDir = join(repoDir, '4-SYSTEM', 'Skills', 'add-toc')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: add-toc\ndescription: Add a table of contents.\n---\n\n# add-toc\n')

    const ctx = await setup(home, {
      workRoot: join(home, 'repos'),
      repos: [{ id: 'rails-template', name: 'Rails Template', githubUrl: 'https://example.com/repo.git' }],
    })

    const skills = await ctx.skills.list({ cwd: home })
    const skill = skills.find(s => s.name === 'rails-template-add-toc')
    expect(skill).toBeDefined()
    expect(skill?.description).toBe('Add a table of contents.')

    const loaded = await ctx.skills.get('rails-template-add-toc', { cwd: home })
    expect(loaded).toBeDefined()
    expect(loaded!.content).toContain('# add-toc')
  })

  it('runs a Rails skill through a subagent and returns the result', async () => {
    const home = await tempDir('rails')
    const repoDir = join(home, 'repos', 'rails-template')
    const skillDir = join(repoDir, '4-SYSTEM', 'Skills', 'add-toc')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: add-toc\ndescription: Add a table of contents.\n---\n\n# add-toc\n\nGenerate a TOC.')
    await mkdir(join(repoDir, '1-SOURCES', 'Commentaries'), { recursive: true })
    await writeFile(join(repoDir, '1-SOURCES', 'Commentaries', 'example.md'), '# Example\n\n* Item one\n* Item two\n')

    const runtime = fakeSubagentRuntime({ output: [{ type: 'text', text: 'Added TOC to example.md' }], stopReason: 'completed' })
    const ctx = await setup(home, {
      workRoot: join(home, 'repos'),
      repos: [{ id: 'rails-template', name: 'Rails Template', githubUrl: 'https://example.com/repo.git' }],
    }, runtime)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('rails-run-1'),
      name: 'rails_run_skill',
      arguments: { repoId: 'rails-template', skillName: 'add-toc', targetFile: '1-SOURCES/Commentaries/example.md' },
      agent: fakeAgent(),
    })

    expect('value' in result).toBe(true)
    const value = (result as unknown as RunSkillValue).value
    expect(value.repoId).toBe('rails-template')
    expect(value.skillName).toBe('add-toc')
    expect(value.targetFile).toBe('1-SOURCES/Commentaries/example.md')
    expect(value.subagentId).toBe('fake-child-id')
    expect(value.stopReason).toBe('completed')
    expect(value.output).toContain('Added TOC')

    const startCall = (runtime as { startActivation: ReturnType<typeof vi.fn> }).startActivation
    expect(startCall).toHaveBeenCalledTimes(1)
    const spec = startCall.mock.calls[0]![0] as { provider: string; label: string; request: { prompt: { type: 'text'; text: string }[]; cwd: string } }
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('rails-rails-template-add-toc')
    expect(spec.request.cwd).toBe(repoDir)
    expect(spec.request.prompt[0]!.text).toContain('# add-toc')
    expect(spec.request.prompt[0]!.text).toContain('1-SOURCES/Commentaries/example.md')
  })

  it('runs a script-backed Rails skill directly when a matching script exists', async () => {
    const home = await tempDir('rails')
    const repoDir = join(home, 'repos', 'rails-template')
    const skillDir = join(repoDir, '4-SYSTEM', 'Skills', 'segment-commentary')
    const scriptsDir = join(skillDir, 'scripts')
    await mkdir(scriptsDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: segment-commentary\ndescription: Segment a commentary.\n---\n\n# segment-commentary')
    await writeFile(join(scriptsDir, 'segment_commentary.py'), [
      '#!/usr/bin/env python3',
      'import sys',
      'import shutil',
      'input_path, output_path = sys.argv[1], sys.argv[2]',
      'report_path = sys.argv[sys.argv.index("--report") + 1]',
      'shutil.copy(input_path, output_path)',
      'with open(report_path, "w") as f: f.write("ok" + chr(9) + "1\\n")',
      'print("segmented")',
    ].join('\n'))
    await mkdir(join(repoDir, '1-SOURCES', 'Commentaries'), { recursive: true })
    await writeFile(join(repoDir, '1-SOURCES', 'Commentaries', 'example.md'), 'Line one. Line two.')

    const ctx = await setup(home, {
      workRoot: join(home, 'repos'),
      repos: [{ id: 'rails-template', name: 'Rails Template', githubUrl: 'https://example.com/repo.git' }],
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('rails-run-script-1'),
      name: 'rails_run_skill',
      arguments: { repoId: 'rails-template', skillName: 'segment-commentary', targetFile: '1-SOURCES/Commentaries/example.md', mode: 'auto' },
      agent: fakeAgent(),
    })

    if ('isError' in result && result.isError) {
      const message = result.content.map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('')
      throw new Error(`tool returned error: ${message}`)
    }
    expect('value' in result).toBe(true)
    const value = (result as unknown as RunSkillValue).value
    expect(value.mode).toBe('script')
    expect(value.stdout).toContain('segmented')
    expect(value.outputFile).toBeDefined()
    expect(value.reportFile).toBeDefined()
  })
})
