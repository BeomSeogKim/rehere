# Contributing

Contributions must be focused, reviewable, and written in English. Keep private
conversations, personal context, credentials, and local working records out of
files, comments, commits, issues, and pull requests.

## Set up

Follow [Getting started](README.md#getting-started) to enable hooks and run the
guards. Stage intended new files before checking; guards inspect tracked paths.
Hooks validate the staged snapshot rather than a different working copy.

## Guidelines

Read [Git workflow](docs/contributing/git-workflow.md) before creating branches,
commits, or PRs. Other task-specific policies are in [the documentation index](docs/README.md).

Agents also follow [AGENTS.md](AGENTS.md). Do not bypass hooks or weaken a guard
to make an invalid change pass. Commits and external actions require explicit
instruction.
