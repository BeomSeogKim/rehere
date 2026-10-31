# Rehere

Revisit places through the memories you share.

Rehere combines old photographs and real people's memories to reconstruct
personally meaningful places that can no longer be visited. People can explore
a place through a browser link and choose to contribute their own memories.
Photographic evidence, personal recollections, and AI proposals remain distinct.

## Status

The [local memory-entry app](app/README.md) saves photographs, written memories
and optional voice recordings, then reopens them for viewing and playback.
It preserves original checksums, source attribution, independent use permissions
and unknown dates. Permitted photos can become partial depth scenes through
local depth estimation and SAM2 segmentation. People can inspect model
proposals, explore the visible surfaces, preview foreground changes and save
versioned transforms. A separately enabled Meta planner connects written
memories to bounded changes with explicit approval and preserved version
history. Unseen areas remain empty. Sharing, accounts and multi-view alignment
are not connected yet.

The production deployment stack is not selected.

## Getting started

Requirements: Git, Bash, Perl, and Python 3. Repository checks require no
API keys or application packages.

```sh
git config core.hooksPath .githooks
python3 tools/check-repository.py
python3 -m unittest discover -s tests -p 'test_*.py'
```

For the local app, install Node.js 26 or later, then run:

```sh
cd app
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm start
```

Open `http://127.0.0.1:4317/`. See the [app guide](app/README.md) for storage,
supported input, limits, recording behavior and the additional local Python
model setup needed for reconstruction. Node.js 26 or later is required.

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
