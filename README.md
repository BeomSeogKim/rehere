# Rehere

Revisit places that can no longer be visited, rebuilt from old photographs and
the memories of people who knew them.

Rehere turns an archival photograph into a partial 3D scene that shows only
what the camera saw. Areas no photograph shows stay empty, and the viewer says
so. People add what they remember as attributed notes. When the optional
planner is enabled, Muse Spark, Meta's model, reads a note and proposes one
bounded change to the scene. The app checks the proposal against the scene and
its sources, and nothing is applied until a person approves it. Each approved
change is saved as a new version, and earlier versions are never overwritten.
A proposal that fails the checks is not applied, and the app shows why.

Throughout, Rehere keeps three kinds of origin apart: what a photograph shows,
what a person remembered, and what a model proposed. Anyone with a link can
visit a saved version without an account and see, for each saved view, which of
these it rests on. Contributors keep control of their material. When a source
is withdrawn, the shared views that depend on it stop being served.

**Why this matters.** When a place is lost, what remains is a handful of
photographs and the people who remember it. The Grand Canyon Lodge on the North
Rim was destroyed by fire in July 2025. Tools that fill gaps with plausible
imagery make memory and invention indistinguishable. Rehere lets a family, a
community or a visitor rebuild a place together, with originals that keep their
checksums and every change recorded as a new, attributed version.

**Demo material.** Photographs of the Grand Canyon Lodge from the Historic
American Buildings Survey (HABS AZ-135-A, Richard Frear, July 1982; Library of
Congress; public domain). Notes in the demo are labelled as demonstration
hypotheses, not recollections.

Built during the Meta Global AI Developer Hackathon (October 27 to
November 4, 2026).

## Status

The [local memory-entry app](app/README.md) saves photographs, written memories
and optional voice recordings, then reopens them for viewing and playback.
It preserves original checksums, source attribution, independent use permissions
and unknown dates. Permitted photos can become partial depth scenes through
local depth estimation and Meta's SAM 2.1 segmentation (open weights). People can inspect model
proposals, explore the visible surfaces, preview foreground changes and save
versioned transforms. A scene can also hold exactly two named objects, each
moved separately, with one explicit left/right rule from the original
viewpoint, with bounded overlap checks between named visible surfaces.
These do not establish whole-room or movement-path clearance. A separately
enabled Meta planner connects written
memories to bounded changes with explicit approval and preserved version
history. Unseen areas remain empty. Local owner sessions, scoped contributor
credentials and recovery protect private content. Written contributions stay
attributed through owner review, immutable alternatives and explicit time
assertions; withdrawal blocks dependent uses. Saved visitor snapshots preserve
selected arrangements and permitted writing behind revocable local links.
Owners can narrow imported source uses or stop dependent use without rewriting
originals; current restrictions also govern existing snapshots.
Imported recordings can be attached to exact saved arrangements with
owner-reviewed captions, which may start from an optional Muse Voice
Transcribe draft that is off by default, and explicitly included in visitor
snapshots.
Scoped contributors can submit photos and recordings for owner review.
A saved visitor snapshot can be exported as a frozen, read-only
[static copy](app/STATIC-DEMO.md) that needs no application server, only static file hosting; it does not follow
later revocation or withdrawal. Multi-view alignment and live hosted
operation remain absent.

The production deployment stack is not selected.

## Getting started

Requirements: Git, Bash, Perl, and Python 3. Repository checks require no
API keys or application packages.
Run the repository commands below from a Git checkout; the content guard
needs Git metadata and cannot run from an extracted source archive.

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
node access-cli.mjs init --credentials-file data/owner-card.json \
  --name "Workspace owner"
npm start
```

Retain the private card and explicitly sign in at `http://127.0.0.1:4317/`.
See the [access guide](app/ACCESS.md) for setup and recovery, and the
[app guide](app/README.md) for storage,
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

Rehere's source code and documentation are licensed under the
[Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE). Third-party
packages keep their own licenses, model weights are not bundled and stay under
their own licenses, and photographs, recordings and memories keep their own
rights. See [third-party notices](THIRD-PARTY-NOTICES.md).
