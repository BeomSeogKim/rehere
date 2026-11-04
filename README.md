# Rehere

Show a place you remember to someone you love.

Rehere helps someone who remembers a place that can no longer be visited show it to the people they love, using old photographs and the memories they share. The viewer can always tell what a photograph shows, what a person remembers, and what a model guesses.

A photograph becomes a partial 3D scene. Unseen surfaces stay empty. A memory can lead to one bounded model proposal, which the owner previews and approves before it becomes a new saved version. Earlier versions remain available.

**For judges**

- [Visit the frozen, read-only demo](https://beomseogkim.github.io/rehere/). This copy does not follow later withdrawal.
- [See the SAM 3.1 lodge outlines](https://beomseogkim.github.io/rehere/lodge-index.html), including misses.
- [Read the evidence-check evaluation](app/evaluation/evidence/EVALUATION.md): 240 live checks, with limitations.
- [Read the live run](app/evaluation/evidence/RUN.md): response IDs, outcomes, latency and estimated cost.

Throughout, Rehere keeps three kinds of origin apart: what a photograph shows,
what a person remembered, and what a model proposed. Anyone with a link can
visit a saved version without an account and see, for each saved view, which of
these it rests on. Contributors keep control of their material. When a source
is withdrawn, the shared views that depend on it stop being served.

**Why this matters.** When a place is lost, what remains is a handful of
photographs and the people who remember it. The Grand Canyon Lodge on the North
Rim was destroyed by fire in July 2025. Tools that fill gaps with plausible
imagery make memory and invention indistinguishable. Rehere lets people share a partial view of a lost place,
with originals that keep their checksums and every approved change recorded
as a new, attributed version.

**Demo material.** Photographs of the Grand Canyon Lodge from the Historic
American Buildings Survey (HABS AZ-135-A, Richard Frear, July 1982; Library of
Congress), a U.S. Government work with no known restrictions on images made by
the U.S. Government, per the [Library of Congress HABS rights
advisory](https://www.loc.gov/rr/print/res/114_habs.html). Notes in the demo
are labelled as demonstration hypotheses, not recollections. The demo's owner
note is read aloud by a Synthetic demo voice (macOS text-to-speech): a
demonstration instruction about the archival photo, not a person, memory or
witness account.

**Meta models in Rehere**

- **Muse Spark** (`muse-spark-1.3`), in the optional planner, turns an owner's note into one bounded proposed edit. The app checks it, and nothing is saved until the owner approves. In an optional, owner-only evidence check, it also says whether chosen photographs support, conflict with, or do not show up to three verbatim parts of a note. Both are off by default.
- **SAM 3.1** (Meta Model API) is an optional, off-by-default outline provider; Meta's SAM 2.1, run locally, remains the default. The demo scene's outlines were replayed from recorded live SAM 3.1 responses (no new call). The [lodge gallery](https://beomseogkim.github.io/rehere/lodge-index.html) shows 30 live one-noun requests on three photographs, with what they missed. Those are 2D estimates, not measurements, and they are not the demo scene's outlines.
- **Muse Voice Transcribe**, optional and off by default, drafts captions for a recorded story, and the owner reviews them before visitors see them.
- **Muse Code**, Meta's coding agent, wrote ten changes that the team reviewed before merging (five entirely, five finished with team edits), including export safety checks, request-limit checks, a visitor accessibility fix, a README setup step and a regression test for the 3D camera controls; it also ran read-only review sweeps.
- **[EVALUATION.md](app/evaluation/evidence/EVALUATION.md):** 240 live evidence checks. Agreement on conflicting claims is 80% (low) / 87% (medium); strict agreement across all claims is 52.5% / 55%, and part-aware agreement is 78.3% / 87.5%. Agreement on `not_visible` claims is 31% at both efforts. Team-written labels with AI assistance, not a benchmark, never historical truth.

Built during the Meta Global AI Developer Hackathon (October 27 to
November 4, 2026).

## Status

The [local memory-entry app](app/README.md) saves photographs, written memories
and optional voice recordings, then reopens them for viewing and playback.
It preserves original checksums, source attribution, independent use permissions
and unknown dates. Permitted photos can become partial depth scenes through
local depth estimation and Meta's SAM 2.1 segmentation (open weights), which
remains the default. People can inspect model proposals, explore the visible
surfaces, preview foreground changes and save versioned transforms. A scene can
also hold exactly two named objects, each moved separately, with one explicit left/right rule from the original
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

Two optional features that call Meta models, both off by default, extend this.
For a two-object build, an operator can have SAM 3.1 propose the outlines
through the Meta Model API from the owner's object names instead of SAM 2.1. The
server keeps an outline only when it matches the owner's drawn box and otherwise
refuses the build; depth stays local. The masks are decoded with Meta's
`meta-sam-parser`, which is under a custom Meta license (see the [third-party
notices](THIRD-PARTY-NOTICES.md)) and is not redistributed here. A stored SAM
3.1 response can be replayed only for a byte-identical request and sends
nothing, while a live request is a separate, budgeted mode. The published demo
scene's outline source reads "SAM 3.1 (Meta Model API)", and its outlines were
built by replaying a stored response, so building it made no new API call.
Neither path measures geometry or establishes history. See [two
objects](app/OBJECTS.md#build-and-confirm-two-objects-from-one-photo) and the
[spatial worker guide](app/spatial/README.md).

An owner can also ask Muse Spark to compare one memory's written note with up to
four of its photos. For up to three verbatim parts of the note it answers
`supports`, `conflicts` or `not_visible`, names the photo and a crop where it
can, and states one thing the photos cannot settle. This is visual agreement in
those photos for that note only, never historical truth. It is owner-only,
nothing is applied to a scene, and the owner accepts or dismisses each result.
See [owner evidence checks](app/README.md#owner-evidence-checks).

Try it: a frozen, read-only demo of one synthetic snapshot is at
https://beomseogkim.github.io/rehere/
It is an offline copy (see the static copy above), so it does not follow
revocation or withdrawal.

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
mkdir -m 700 -p data
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
The repository is hosted at https://github.com/BeomSeogKim/rehere; open pull
requests against `main`. The CI Guard workflow runs on them.

## License

Rehere's source code and documentation are licensed under the
[Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE). Third-party
packages keep their own licenses, model weights are not bundled and stay under
their own licenses, and photographs, recordings and memories keep their own
rights. See [third-party notices](THIRD-PARTY-NOTICES.md).
