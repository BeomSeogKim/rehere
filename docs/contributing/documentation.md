# Documentation

Write concise English for a reader who has no access to internal conversations.
Document the resulting technical contract, its reason, and its limits. Keep
private requests, chat excerpts, session reports, personal notes, and local
machine details outside this repository. Summarize an approved technical
decision without its conversational history.

## README

The root README is the entry point. Keep these sections:

1. `# Rehere`: a short product description and why it is useful.
2. `## Status`: what actually works and what is still absent.
3. `## Getting started`: prerequisites and commands that work in a fresh clone.
4. `## Development`: checks and links to deeper technical documentation.
5. `## Contributing`: the contribution guide and available review process.
6. `## License`: the selected license, or an explicit pending status.

Do not add installation steps for an unselected stack, fake badges, private
contact information, or a demo URL that has not been published. Do not call a
configured workflow a successful CI run. Use relative links for repository
files and public primary-source links for external claims.

## Other documents

- Keep detailed policies and architecture out of the root README.
- Put each rule in one owning guide and link to it from the relevant index.
- Keep setup commands, supported behavior, and limitations current with changes.
- Clearly label examples as synthetic when they could be mistaken for evidence.
- Use small examples; explain decisions rather than narrating the work session.
- Remove obsolete instructions when behavior changes. Preserve relevant public
  technical rationale, not private deliberation or transcripts.

The content guard catches non-ASCII letters as a conservative English-language
check. Use Unicode escapes for language-specific test data. It does not prove
that ASCII prose is English or suitable for publication; review still must.

## Source

Adapted from [GitHub's README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes),
checked on 2026-10-31. The exact sections and language boundary are Rehere rules.
