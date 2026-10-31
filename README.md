# Rehere

Revisit places through the memories you share.

Rehere combines old photographs and real people's memories to reconstruct
personally meaningful places that can no longer be visited. People can explore
a place through a browser link and choose to contribute their own memories.
Photographic evidence, personal recollections, and AI proposals remain distinct.

## Status

This hackathon repository currently contains development conventions and
repository checks. There is no application, model integration, or live demo yet.
The application stack, spatial engine, and model path are not selected.

## Getting started

Requirements: Git, Bash, Perl, and Python 3. Repository checks require no
API keys or application packages.

```sh
git config core.hooksPath .githooks
python3 tools/check-repository.py
python3 -m unittest discover -s tests -p 'test_*.py'
```

## Development

Start with [AGENTS.md](AGENTS.md) when using a coding agent. Read only the
policy relevant to the task from [the documentation index](docs/README.md).
If the agent does not load it automatically, begin with:
`Read AGENTS.md before making any changes.`
All repository content is English and must be understandable without private
conversations or an external context repository.

The guard validates repository content and Markdown links; its tests exercise
valid and invalid changes. New files must be staged to enter tracked-file checks.
Keep only files and tools with a concrete current purpose. Application code must
add its own documented setup and checks when introduced.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review rules. Keep each
change focused, explain its technical purpose, and provide relevant validation.
No remote has been configured. Initial publication and shared base-branch
setup require a separate instruction.

## License

A license has not been selected. No open-source license grant is claimed yet.
