# Agent instructions

These rules are mandatory for every contributor, including Claude and Codex.
Use this file as the shared entry point; do not add vendor instruction aliases.

Include only what is necessary for the current work. Do not add tools, files,
abstractions, dependencies, or placeholder configuration without a concrete need.

## Always apply

- Keep all repository content, filenames, comments, commits, and PRs in English.
- Communicate with other agents in English.
- Do not add AI signatures or attribution to files, comments, commits, or PRs.
- Include only product code, public technical documentation, and public or
  synthetic examples. Never copy private conversations, personal notes, session
  logs, local paths, account records, credentials, or private planning here.
- Describe technical decisions on their own merits. Do not record who requested
  them in a private conversation, chat quotations, or a session narrative.
- Read the README and run `git status --short` before editing. Preserve existing
  work and stage only your own paths. Keep changes limited to the task.
- Do not add an application stack, model, or dependency without a task needing it.
- Use Meta credits for bounded work. Check credit and usage before and between
  batches, bound costs and retries, and stop if credit status or likely cost is
  unknown. Alerts and local budgets are not provider-enforced spending caps.
- Do not commit until explicitly asked.
  Pushes, PR creation, merges, remote setup, and publication also need instruction.

## Read only the applicable policy

Read each relevant document in full before doing that work. Follow its linked
rules; do not preload unrelated policies or duplicate them in this file.

| Task | Required reading |
|---|---|
| Branch, commit, pull request, or merge | [Git workflow](docs/contributing/git-workflow.md) |
| README or other documentation | [Documentation](docs/contributing/documentation.md) |
| Code, tests, or comments | [Code and comments](docs/contributing/code-style.md) |
| Hooks, checks, CI, or dependency/action changes | [CI guards](docs/contributing/ci-guards.md) |

Run `python3 tools/check-repository.py` and the affected tests before handing
off changes. Do not bypass failing guards. Report checks and limitations outside
the repository; do not add session reports or transcripts to the source tree.
