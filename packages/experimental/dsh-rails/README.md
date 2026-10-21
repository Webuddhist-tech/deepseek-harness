---
description: "Run WeBuddhist Rails text-pipeline repos inside DeepSeek Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-rails

Experimental plugin that lets a DeepSeek Harness deployment list, clone, and run skills from WeBuddhist Rails GitHub repositories.

## Summary

This package connects a DSH instance to the Rails text-processing pipeline repositories. It exposes tools for repo selection and cloning, and it registers each repo's `4-SYSTEM/Skills/*/SKILL.md` files as DSH skills so the agent can load and follow them.

## Use this package

Mount the plugin in a DSH profile and configure the repositories you want to offer.

```yaml
- name: '@deepseek-ai/dsh-rails'
  config:
    workRoot: '/var/dsh-rails'
    repos:
      - id: rails-template
        name: Rails Template
        githubUrl: https://github.com/WeBuddhist/rails-template.git
        description: Reference Rails vault with all skills
      - id: 21-taras
        name: 21 Taras Rails
        githubUrl: https://github.com/WeBuddhist/21-taras-rails.git
```

### Tools

- `rails_list_repos` — returns the configured repository list.
- `rails_clone_repo` — clones or pulls a repo into `<workRoot>/<repo-id>/`.
- `rails_run_skill` — runs a Rails skill against a target file. Script-backed skills (e.g. `segment-commentary`) execute their matching `scripts/<skill_name>.py` directly; prompt-backed skills (e.g. `add-toc`) are delegated to a DSH subagent.

### Skills

After a repo is cloned, its skills appear in the session skill catalog with namespaced identifiers such as `rails-template-add-toc` or `21-taras-toc-generate`. Call the `skill` tool with the exact name to load the full SKILL.md body.

## Model Experience

No direct prompt effect. The plugin adds tools and skill entries to the session catalog.

## Development

```sh
# build the package
pnpm -F @deepseek-ai/dsh-rails build

# run unit tests from the repo root
pnpm vitest run packages/experimental/dsh-rails/tests/rails.spec.ts
```

## Deploy on Render

A Render Blueprint is provided at the repository root in `render.yaml`. It deploys the DSH web profile with the Rails plugin patch applied.

1. Push `render.yaml` and `packages/experimental/dsh-rails/render-start.sh` to your Git repository.
2. In the Render dashboard, create a new Blueprint Instance and select the repository.
3. Set the secret environment variables when prompted:
   - `KIMI_K3_API_KEY` — DSH agent model provider key (Moonshot Kimi K3).
   - `GEMINI_API_KEY` — used by Rails segmentation scripts.
4. Render mounts a persistent disk at `/var`. `DSH_HOME` and `DSH_RAILS_WORK_ROOT` default to `/var/dsh-home` and `/var/dsh-rails` so sessions and cloned repos survive restarts.
5. After deploy, open the printed URL and run `rails_list_repos` in the chat.

## Known Limitations and Deferred Work

- Git clone/pull is implemented with the system `git` binary; private repositories require an SSH key or token configured on the host.
- Only `4-SYSTEM/Skills/*/SKILL.md` files are discovered; `.claude/commands/*.md` shortcuts are not surfaced as skills.
- `rails_run_skill` uses a fixed `--max-syllables 40` convention for script-backed skills; skills with non-standard CLI signatures should use `mode: 'subagent'`.
- No Web client panel exists yet; repo selection is model-driven through `rails_list_repos` / `rails_clone_repo`.
- The DSH agent provider key is expected via the profile's configured provider (e.g. `DEEPSEEK_API_KEY`); the Gemini key is passed to Rails scripts through `GEMINI_API_KEY`.
