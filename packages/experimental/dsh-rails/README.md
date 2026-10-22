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
    workRoot: '/var/data/dsh-rails'
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

1. Push `render.yaml`, `packages/experimental/dsh-rails/render-start.sh`, and `packages/experimental/dsh-rails/render-proxy.mjs` to your Git repository.
2. In the Render dashboard, create a new Blueprint Instance and select the repository.
3. Set the secret environment variables when prompted:
   - `KIMI_K3_API_KEY` — DSH agent model provider key (Moonshot Kimi K3).
   - `GEMINI_API_KEY` — used by Rails segmentation scripts.
4. Render mounts a persistent disk at `/var/data`. `DSH_HOME` and `DSH_RAILS_WORK_ROOT` default to `/var/data/dsh-home` and `/var/data/dsh-rails` so sessions and cloned repos survive restarts. Do not mount the disk over `/var` itself: that hides the system's `/var` contents.
5. After deploy, open the `https://<service>.onrender.com/?token=…` URL printed in the service log and run `rails_list_repos` in the chat.

Render routes traffic only to a port bound on `0.0.0.0`, and the DSH webserver refuses wildcard bind addresses. `render-start.sh` therefore starts `render-proxy.mjs` on `0.0.0.0:$PORT` first, so Render's port scan finds the port while DSH is still starting, and runs DSH on `127.0.0.1:$DSH_UPSTREAM_PORT` (default `31080`, above `$PORT` so a scanner that routes to the lowest open port still picks the relay) behind it. The relay forwards HTTP and WebSocket traffic with its `Host` and `Origin` headers unchanged. DSH receives `--trusted-host $RENDER_EXTERNAL_HOSTNAME` so its `/api` fence admits the public hostname. The blueprint sets no `healthCheckPath`, so Render probes the detected port over TCP and marks the deploy live once the relay listens; the relay answers 502 until DSH is ready, usually within two minutes. `GET /healthz` stays available for manual checks. The service is reachable from the internet; the access token in the log is its only credential.

## Known Limitations and Deferred Work

- Git clone/pull is implemented with the system `git` binary; private repositories require an SSH key or token configured on the host.
- Only `4-SYSTEM/Skills/*/SKILL.md` files are discovered; `.claude/commands/*.md` shortcuts are not surfaced as skills.
- `rails_run_skill` uses a fixed `--max-syllables 40` convention for script-backed skills; skills with non-standard CLI signatures should use `mode: 'subagent'`.
- No Web client panel exists yet; repo selection is model-driven through `rails_list_repos` / `rails_clone_repo`.
- The DSH agent provider key is expected via the profile's configured provider (e.g. `DEEPSEEK_API_KEY`); the Gemini key is passed to Rails scripts through `GEMINI_API_KEY`.
