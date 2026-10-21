/**
 * Run WeBuddhist Rails text-pipeline repos inside DeepSeek Harness.
 *
 * @module @deepseek-ai/dsh-rails
 */

import { execFile } from 'node:child_process'
import { access, mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BUNDLED_SKILL_RANK, type SkillProvider, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

export const name = 'rails'
export const inject = ['tools', 'skills']

const DEFAULT_WORK_ROOT = '/tmp/dsh-rails'
const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

/** One Rails repo the deployment knows about. */
export interface RailsRepo {
  /** Machine-friendly identifier, used as directory name and skill namespace. */
  readonly id: string
  /** Human-readable label. */
  readonly name: string
  /** HTTPS or SSH Git URL. */
  readonly githubUrl: string
  /** Optional short description. */
  readonly description?: string
}

/** Configuration for the Rails plugin. */
export interface Config {
  /** Directory where repos are cloned. */
  workRoot?: string
  /** Repos the user can select from the UI or model. */
  repos?: RailsRepo[]
  /** Subagent provider used by rails_run_skill (default 'spawn'). */
  subagentProvider?: string
}

/** Validate and default the Rails plugin configuration. */
export const Config: z<Config> = z.object({
  workRoot: z.string().default(DEFAULT_WORK_ROOT),
  repos: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    githubUrl: z.string().required(),
    description: z.string(),
  })).default([]),
  subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER),
})

/**
 * Register Rails repo tools and a skill provider that surfaces Rails
 * SKILL.md files from cloned repos.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const workRoot = resolve(config.workRoot ?? DEFAULT_WORK_ROOT)
  const repos = config.repos ?? []
  const reposById = new Map(repos.map(repo => [repo.id, repo]))
  const subagentProvider = config.subagentProvider ?? DEFAULT_SUBAGENT_PROVIDER

  ctx.tools.register(defineTool({
    name: 'rails_list_repos',
    description: 'List the Rails text-pipeline repositories configured for this DeepSeek Harness instance.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repos: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                githubUrl: { type: 'string', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.repos ?? []).map(repo => `- ${repo.id}: ${repo.name} (${repo.githubUrl})`).join('\n'),
      }],
    },
    async execute() {
      return Promise.resolve({ repos: repos.map(repo => ({ ...repo })) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rails_clone_repo',
    description: 'Clone or pull a configured Rails repository into the server workspace so its skills and sources are available.',
    parameters: {
      repoId: { type: 'string', required: true, description: 'The id of the repo from rails_list_repos.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          status: { type: 'string', required: true },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.status}: ${value.path}`,
      }],
    },
    async execute(args, exec) {
      const repo = reposById.get(args.repoId)
      if (repo === undefined) {
        throw new Error(`unknown repo "${args.repoId}"`)
      }
      const repoPath = join(workRoot, repo.id)
      await mkdir(repoPath, { recursive: true })

      const exists = await pathExists(join(repoPath, '.git'))
      const gitArgs = exists
        ? ['-C', repoPath, 'pull', '--ff-only']
        : ['clone', '--', repo.githubUrl, repoPath]

      const { stdout, stderr } = await runGit(gitArgs, exec.signal)

      return {
        repoId: repo.id,
        path: repoPath,
        status: exists ? 'pulled' : 'cloned',
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      }
    },
    presentCall(args) {
      return { card: 'terminal', title: `git clone ${args.repoId}`, description: 'Clone or update Rails repo' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rails_run_skill',
    description: 'Run a Rails skill from a cloned repository against a target file. Script-backed skills (e.g. segment-commentary) run their Python script directly; prompt-backed skills (e.g. add-toc) are delegated to a subagent.',
    parameters: {
      repoId: { type: 'string', required: true, description: 'The id of the repo from rails_list_repos.' },
      skillName: { type: 'string', required: true, description: 'The skill folder name under 4-SYSTEM/Skills/ in the repo (e.g. add-toc).' },
      targetFile: { type: 'string', required: true, description: 'Path to the target file inside the repo, relative to the repo root (e.g. 1-SOURCES/Commentaries/example.md).' },
      mode: {
        type: 'string',
        enum: ['auto', 'subagent', 'script'],
        description: 'Execution mode: auto detects a scripts/<skill>.py file, subagent always delegates, script always calls the matching Python script.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoId: { type: 'string', required: true },
          skillName: { type: 'string', required: true },
          targetFile: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          subagentId: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'string' },
          outputFile: { type: 'string' },
          reportFile: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderRunSkillResult(value),
      }],
    },
    async execute(args, exec) {
      const repo = reposById.get(args.repoId)
      if (repo === undefined) {
        throw new Error(`unknown repo "${args.repoId}"`)
      }
      const repoPath = join(workRoot, repo.id)
      const skillDir = join(repoPath, '4-SYSTEM', 'Skills', args.skillName)
      const skillPath = join(skillDir, 'SKILL.md')
      if (!(await pathExists(skillPath))) {
        throw new Error(`skill "${args.skillName}" not found in repo "${args.repoId}"`)
      }
      const targetPath = join(repoPath, args.targetFile)
      if (!(await pathExists(targetPath))) {
        throw new Error(`target file "${args.targetFile}" not found in repo "${args.repoId}"`)
      }

      const mode = args.mode ?? 'auto'
      const scriptPath = join(skillDir, 'scripts', `${args.skillName.replace(/-/g, '_')}.py`)
      const useScript = mode === 'script' || (mode === 'auto' && (await pathExists(scriptPath)))

      if (useScript) {
        return runScriptSkill({
          repoId: args.repoId,
          skillName: args.skillName,
          targetFile: args.targetFile,
          repoPath,
          scriptPath,
          targetPath,
          signal: exec.signal,
        })
      }

      return runSubagentSkill({
        repoId: args.repoId,
        skillName: args.skillName,
        targetFile: args.targetFile,
        repoPath,
        skillPath,
        subagentProvider,
        subagents: ctx.get('subagents') as SubagentRuntimeLike | undefined,
        parent: exec.agent,
        signal: exec.signal,
      })
    },
    presentCall(args) {
      return { card: 'terminal', title: `rails run ${args.skillName}`, description: `Run Rails skill ${args.skillName} on ${args.targetFile}` }
    },
  }))

  const provider: SkillProvider = {
    name: 'rails-skills',
    async list(options) {
      const entries: SkillCandidate[] = []
      const base = options.cwd !== undefined ? resolve(options.cwd) : workRoot
      const repoDirs = await discoverRepoDirs(base, workRoot, repos)
      for (const { repoId, repoPath } of repoDirs) {
        const skillsDir = join(repoPath, '4-SYSTEM', 'Skills')
        const skillNames = await listSkillDirs(skillsDir)
        for (const skillName of skillNames) {
          const skillPath = join(skillsDir, skillName, 'SKILL.md')
          const meta = await readSkillMeta(skillPath)
          if (meta === undefined) continue
          const namespacedName = `${repoId}-${skillName}`
          entries.push({
            name: namespacedName,
            description: meta.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            provider: provider.name,
            rank: BUNDLED_SKILL_RANK,
            locator: { skillPath, namespacedName, repoId },
            path: skillPath,
          })
        }
      }
      return entries
    },
    async get(candidate) {
      const locator = candidate.locator as { skillPath: string; namespacedName: string; repoId: string }
      const content = await readFile(locator.skillPath, 'utf8')
      return {
        name: candidate.name,
        description: candidate.description,
        content: stripFrontmatter(content),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        path: locator.skillPath,
        resourceBase: { kind: 'directory', path: join(locator.skillPath, '..') },
      }
    },
  }

  ctx.skills.registerProvider((control) => {
    control.signal.addEventListener('abort', () => {}, { once: true })
    return provider
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

async function discoverRepoDirs(
  cwd: string,
  workRoot: string,
  repos: readonly RailsRepo[],
): Promise<{ repoId: string; repoPath: string }[]> {
  const results: { repoId: string; repoPath: string }[] = []
  if (await pathExists(workRoot)) {
    for (const repo of repos) {
      const repoPath = join(workRoot, repo.id)
      if (await pathExists(join(repoPath, '4-SYSTEM', 'Skills'))) {
        results.push({ repoId: repo.id, repoPath })
      }
    }
  }
  // Also accept cwd if it is itself a Rails repo.
  if (await pathExists(join(cwd, '4-SYSTEM', 'Skills'))) {
    const repoId = repos.find(repo => cwd === join(workRoot, repo.id))?.id ?? 'local'
    if (!results.some(r => r.repoPath === cwd)) {
      results.push({ repoId, repoPath: cwd })
    }
  }
  return results
}

async function listSkillDirs(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = join(skillsDir, entry.name, 'SKILL.md')
      if (await pathExists(skillFile)) {
        names.push(entry.name)
      }
    }
    return names.sort()
  }
  catch {
    return []
  }
}

interface SkillMeta {
  description: string
}

async function readSkillMeta(skillPath: string): Promise<SkillMeta | undefined> {
  try {
    const content = await readFile(skillPath, 'utf8')
    const frontmatter = parseFrontmatter(content)
    const description = frontmatter?.description ?? frontmatter?.name ?? ''
    if (description === '') return undefined
    return { description: description.replace(/\s+/g, ' ').trim() }
  }
  catch {
    return undefined
  }
}

function parseFrontmatter(content: string): Record<string, string> | undefined {
  if (!content.startsWith('---\n')) return undefined
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return undefined
  const block = content.slice(4, end)
  const result: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line)
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      result[match[1]] = match[2].trim()
    }
  }
  return result
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return content
  return content.slice(end + 5).trimStart()
}

function runGit(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error('git operation failed'))
      }
      else {
        resolve({ stdout, stderr })
      }
    })
    signal?.addEventListener('abort', () => {
      child.kill()
      reject(new Error('git operation aborted'))
    }, { once: true })
  })
}

/** Build the prompt sent to the subagent that executes a Rails skill. */
function buildSkillPrompt(skillName: string, skillContent: string, repoPath: string, targetFile: string): string {
  return [
    `You are running the Rails skill "${skillName}" from the repository at ${repoPath}.`,
    '',
    'Follow the SKILL.md instructions below exactly.',
    'The repo root is your working directory.',
    `The target file is: ${targetFile}`,
    'Use file-read, file-edit, and shell tools as needed.',
    'Write any scratch or output files under 0-INBOX/temp/.',
    'When you are finished, summarize what you did and which files you changed.',
    '',
    '--- SKILL.md ---',
    skillContent,
  ].join('\n')
}

interface RunSkillResult {
  repoId: string
  skillName: string
  targetFile: string
  mode: string
  stdout?: string
  stderr?: string
  subagentId?: string
  stopReason?: string
  output?: string
  outputFile?: string
  reportFile?: string
}

interface RunScriptSkillOptions {
  repoId: string
  skillName: string
  targetFile: string
  repoPath: string
  scriptPath: string
  targetPath: string
  signal?: AbortSignal
}

async function runScriptSkill(options: RunScriptSkillOptions): Promise<RunSkillResult> {
  const { repoId, skillName, targetFile, repoPath, scriptPath, targetPath, signal } = options
  if (!(await pathExists(scriptPath))) {
    throw new Error(`script-backed skill "${skillName}" has no matching script at ${scriptPath}`)
  }

  const tempDir = join(repoPath, '0-INBOX', 'temp')
  await mkdir(tempDir, { recursive: true })
  const basename = targetPath.split('/').pop() ?? 'output'
  const outputFile = join(tempDir, `${skillName.replace(/-/g, '_')}-${basename}`)
  const reportFile = join(tempDir, `${skillName.replace(/-/g, '_')}-${basename}.report.tsv`)

  const { stdout, stderr } = await runPythonScript(
    scriptPath,
    [targetPath, outputFile, '--report', reportFile, '--max-syllables', '40'],
    { cwd: repoPath, ...signal === undefined ? {} : { signal } },
  )

  return {
    repoId,
    skillName,
    targetFile,
    mode: 'script',
    outputFile,
    reportFile,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

interface RunSubagentSkillOptions {
  repoId: string
  skillName: string
  targetFile: string
  repoPath: string
  skillPath: string
  subagentProvider: string
  subagents: SubagentRuntimeLike | undefined
  parent: unknown
  signal: AbortSignal
}

async function runSubagentSkill(options: RunSubagentSkillOptions): Promise<RunSkillResult> {
  const { repoId, skillName, targetFile, repoPath, skillPath, subagentProvider, subagents, parent, signal } = options
  if (subagents === undefined) {
    throw new Error('rails_run_skill subagent mode requires the subagent runtime; add a subagent provider such as @deepseek-ai/dsh-subagent-spawn-in-process to the profile')
  }
  if (parent === undefined) {
    throw new Error('rails_run_skill subagent mode requires a calling agent')
  }

  const skillContent = await readFile(skillPath, 'utf8')
  const prompt = buildSkillPrompt(skillName, skillContent, repoPath, targetFile)

  const activation = await subagents.startActivation({
    provider: subagentProvider,
    label: `rails-${repoId}-${skillName}`,
    request: {
      parent,
      prompt: [{ type: 'text', text: prompt }],
      cwd: repoPath,
    },
    signal,
    delivery: 'caller',
  })

  let result
  try {
    result = await activation.result
  }
  finally {
    await activation.dispose()
  }

  return {
    repoId,
    skillName,
    targetFile,
    mode: 'subagent',
    subagentId: activation.childId,
    stopReason: result.stopReason,
    output: blocksToText(result.output),
  }
}

function renderRunSkillResult(value: Record<string, string | undefined>): string {
  if (value.mode === 'script') {
    return [
      `Ran ${value.skillName} on ${value.targetFile} (script mode).`,
      `Output: ${value.outputFile}`,
      value.reportFile ? `Report: ${value.reportFile}` : '',
      '',
      value.stdout || '(no stdout)',
      value.stderr ? `\nstderr:\n${value.stderr}` : '',
    ].filter(Boolean).join('\n')
  }
  return [
    `Ran ${value.skillName} on ${value.targetFile} (subagent ${value.subagentId}).`,
    `Stop reason: ${value.stopReason}.`,
    '',
    value.output || '(no output)',
  ].join('\n')
}

function runPythonScript(
  script: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [script, ...args], { encoding: 'utf8', cwd: options.cwd, env: process.env }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error(`python3 script failed: ${stderr}`))
      }
      else {
        resolve({ stdout, stderr })
      }
    })
    options.signal?.addEventListener('abort', () => {
      child.kill()
      reject(new Error('python3 script aborted'))
    }, { once: true })
  })
}

/** Flatten content blocks to a plain-text summary. */
function blocksToText(blocks: readonly SubagentContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'thinking') return block.thinking ?? ''
    return `[${block.type}]`
  }).join('').trim()
}

/** Minimal runtime shape consumed by rails_run_skill; avoids a heavy dependency on dsh-subagent. */
interface SubagentRuntimeLike {
  startActivation(spec: SubagentActivationSpecLike): Promise<SubagentActivationLike>
}

interface SubagentActivationSpecLike {
  readonly provider: string
  readonly label: string
  readonly request: {
    readonly parent: unknown
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly cwd?: string
  }
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

interface SubagentActivationLike {
  readonly childId: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

interface SubagentResultLike {
  readonly output: readonly SubagentContentBlock[]
  readonly stopReason: string
}

interface SubagentContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
}
