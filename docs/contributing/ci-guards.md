# CI guards

Rules apply equally to human and automated contributors. Local hooks provide
early feedback; the same checks run in CI. Do not bypass or weaken them to
accept an invalid change.

## Checks

| Check | Local enforcement | CI enforcement |
|---|---|---|
| Branch name and protected branch | Pre-commit hook | PR head branch check |
| Commit format and content | Commit message hook | Every commit in the PR range |
| PR title and required sections | Run the convention tool before submission | PR metadata check |
| AI signatures in files, comments, commits, and PRs | Content and metadata guards | Same guards |
| English-language guard and known private markers | Working-tree check and staged pre-commit check | Tracked-content check |
| Environment files, private logs, keys, and local paths | Staged pre-commit check | Tracked-content check |
| README structure and repository-contained links | Repository content guard | Same command |
| Guard behavior | Python unittest discovery | Same command |

`python3 tools/check-repository.py` inspects working copies of tracked files.
The pre-commit guard uses Git's staged blobs so an unstaged edit cannot conceal
staged private content.
Diagnostics name the rule, file, and line without printing the matched text.

Run guard tests with `python3 -m unittest discover -s tests -p 'test_*.py'`.

The language gate rejects non-ASCII letters, not ordinary punctuation. Private
content checks cover recognizable conversation links and role records, local
home paths, prohibited log directories, environment files, and selected secret
formats. Non-text files and symlinks require a future explicit policy before
they can be tracked. No blanket exemptions are configured.

These checks are not a complete secret scanner or a semantic privacy detector.
Review every diff, including PR descriptions and commit bodies, for private
context, English prose, and necessary comments. Passing CI does not authorize
publication or certify that arbitrary prose is safe.

## Workflow safety

- Run untrusted PR code on GitHub-hosted runners under `pull_request`, never a
  privileged `pull_request_target` job with secrets.
- Grant only `contents: read`, avoid repository secrets, and do not persist
  checkout credentials.
- Pin actions to full commit SHAs; verify the upstream release when changing
  a pin. Keep untrusted PR metadata in environment variables, not inline code.
- Run checks without path filters so documentation and configuration changes
  cannot skip the required job. Use a timeout and cancel obsolete runs.

The workflow is `CI Guard` and its job is `repository`. After the first remote
run, require its repository check and PRs on `main`, restrict direct updates,
and allow squash merging. Confirm the actual check name in that run when
configuring protection. Branch protection is a server setting, not a property
of this workflow file. No remote or protection rule has been configured yet.

## Source

Adapted from [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use),
checked on 2026-10-31. Content rules and the required-check name are local choices.
