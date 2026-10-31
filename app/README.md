# Rehere local app

A local web application for gathering the material behind a remembered place:
photographs, a written memory and an optional voice recording. Photographs and
writing are enough to save; the microphone is requested only when the person
presses Record, and declining it never blocks saving.

## What it does

- Add and remove photo previews, write a memory, and optionally record, stop,
  listen back to and discard a voice recording. Recording stops automatically
  after five minutes.
- While a recording is in progress, saving offers either **Stop and save**,
  which waits for the recorder's final data, or **Save without voice**, which
  discards the recording. A pending microphone request never blocks saving.
  Opening a saved memory cancels a pending microphone request and stops an
  active recording, keeping the finished recording in the form.
- **Save** sends files separately and reports success only after the final
  memory is committed. A failed file leaves received files in place; remove,
  replace or retry it without sending successful files again. An unclear
  response is checked against the same unfinished save before retrying.
- After a refresh, explicitly resume an unfinished save from the server.
  Received files, text and source settings return; files that never reached
  the server must be selected again, removed or replaced. A missing recording
  needs a new take. Temporary received files are labelled as not saved yet.
- Saved memories are listed and can be reopened to view photos, read the text
  and play the recording. Saved memories cannot be edited.

Each photo, written memory and recording has its own source details: provider
label, origin/reference, and separate permissions for place construction,
model processing and visitor sharing. Permissions start off. Provider labels
are attribution, not verified identity, and selecting a permission does not
start processing or publish anything. Current grants can be narrowed or stopped
through [source use controls](SOURCE-USES.md), without rewriting the originals.

Saved photographs with both place-construction and model-processing permission
can be used to build a partial scene. Select a foreground box, review the
inferred depth and mask, explore the visible surfaces, and preview a foreground
move or rotation before saving it. Unseen areas stay empty. This is a local
model reconstruction from one photograph, not a complete room or calibrated
geometry. A scene can instead hold exactly two named objects that are confirmed,
moved and related separately; see [two objects](OBJECTS.md).

Scoped contributors can submit written recollections. Owners can preview a
manual change, adopt it or preserve an alternative, and record a separate
explicit time assertion. Withdrawal blocks dependent spatial uses. See the
[collaboration guide](COLLABORATION.md) for grants, review and restoration.

Recorded stories connect a permitted imported recording to an explicitly chosen
saved arrangement and its foreground object, or one named object of a
two-object scene.
Human-supplied captions
and provider attribution accompany a converted playback copy, with explicit
visitor selection and current withdrawal checks. See [recorded stories](STORIES.md).

Not included: automatic transcription, multi-view alignment, photo or voice
contributions, hosted account integration, and recovery of input that never
reached the server.

Saved visitor snapshots can include selected arrangements and permitted written
recollections. Preview the actual visitor screen before issuing a local link;
later private changes stay private, while current withdrawal overrides a frozen
copy. See the [sharing guide](SHARING.md) for access, revocation and limits.

## Getting started

Requires Node.js 26 or later. Three.js is pinned for the spatial viewer.
Set up the local workspace owner and retain its private access card using
[the access guide](ACCESS.md) before signing in. No web visitor can create or
claim the owner account.

```sh
cd app
npm ci --ignore-scripts --no-audit --no-fund
npm start   # http://127.0.0.1:4317/ (set PORT to change it)
npm test
```

The server listens on the loopback interface only. Saved memories and workspace
authority are written to `app/data/`, which is ignored by Git. Deleting that
folder removes both, including any access card kept inside it. Keep a separate
secure copy of the current card.

Photo reconstruction additionally requires the isolated Python environment
and locally cached model weights described in [the worker guide](spatial/README.md).
The server uses `spatial/.venv/bin/python` by default. Set `PHOTO_PYTHON` for
this process to use another prepared Python executable. Missing dependencies
or weights produce a failed job with a setup message; there is no download
or paid-API fallback.

## Storage

Each save becomes `data/drafts/<id>/` holding `draft.json` and the files, named
by the server (`photo-1.jpg`, `voice.webm`). Files are written to
`data/incoming/<id>/` first and moved into place only when complete, so a
failed save leaves no partial memory and does not affect earlier ones.

| Endpoint | Purpose |
|---|---|
| `POST /api/drafts` | Multipart fields `text`, `photos` (repeatable) and `voice` |
| `GET /api/drafts` | Summaries, newest first |
| `GET /api/drafts/<id>` | One saved memory |
| `GET /api/drafts/<id>/assets/<name>` | A file listed in that memory; supports byte ranges |

The entry screen first creates an owner-private unfinished save under
`data/intakes/<id>/`. Adding a file does not upload it; only Save starts the
transfer. Each planned original has a stable part ID, byte count and SHA-256.
Files are validated and acknowledged separately. Updating a plan checks its
revision and keeps received parts with unchanged identities; changed originals
need new IDs and start with no uses allowed. File names and modification times
are display hints, never paths or source dates.

| Endpoint | Purpose |
|---|---|
| `POST /api/intakes` | Start or reopen the same explicit Save using `requestId`, raw `text`, `parts` and `metadata` |
| `GET /api/intakes` | Open unfinished saves, newest first |
| `GET /api/intakes/<id>` | Current progress or a terminal saved/discarded receipt |
| `POST /api/intakes/<id>/parts/<part>` | Send one planned original as `application/octet-stream` |
| `GET /api/intakes/<id>/parts/<part>` | Received bytes of an active part of an open save; supports ranges |
| `POST /api/intakes/<id>/plan` | Update text, settings and active parts using `requestId` and `baseRevision` |
| `POST /api/intakes/<id>/commit` | Commit all received originals using `requestId` and `baseRevision` |
| `POST /api/intakes/<id>/discard` | Explicitly discard temporary progress using `requestId` |

Finalization rechecks the originals and atomically stores one ordinary draft
with a private receipt. A lost response or a process restart resolves to that
same draft. Terminal intake routes return identifiers and receipts only;
content goes through the saved draft's current source-use controls. Temporary
part access ends even when cleanup fails. Open progress has no automatic
expiry; explicitly discard it when no longer needed. Browser storage holds
only opaque pending IDs scoped to the owner, never text, files or source details.
Unavailable browser storage still permits recovery from the server's open list.
These guarantees coordinate one process and process restarts, without fsync
or multi-process locking.

## Original sources and dates

New drafts use `schemaVersion: 2` and contain a `sources` array. Each original
gets a server-generated source ID, kind, SHA-256 checksum, byte count and its
source details. Photo and voice entries refer to those records through
`sourceId`; `textSourceId` identifies the written original. Meaningful written
text is preserved as received, including whitespace, and hashed as UTF-8.
The entry screen sends text as JSON and preserves its line breaks. The legacy
multipart endpoint normalizes string-field line breaks to CRLF during
transport; its checksum describes that received original. No derived copy replaces an
original. Derived assets have separate records and a reference to their
original.

Capture date, file creation time, file modification time and a person's
estimated period are distinct. Unknown dates remain unknown. Browser file
modification time is informational and never becomes a capture or creation
date. Dates entered by a person are assertions; EXIF extraction is not
implemented. Saved memories from before source records remain readable with
metadata unavailable and no inferred permissions.

`POST /api/drafts` also accepts one optional `metadata` JSON string with
`photos` in multipart photo order, and `text` and `voice` entries. Absent
materials use `null`; omitted details default to unknown and all permissions
off. A supplied source entry has this shape:

```json
{
  "provider": "Example contributor",
  "origin": { "kind": "own", "reference": "" },
  "permissions": { "place": true, "model": false, "share": false },
  "dates": {
    "capturedOn": null,
    "fileCreatedAt": null,
    "fileModifiedAt": null,
    "estimatedPeriod": "Before the renovation"
  }
}
```

Origin kinds are `own`, `public`, `other` and `unknown`. Supplied objects
require the documented fields and reject unknown fields, invalid calendar
dates, wrong types and mismatched material counts. Metadata is stored
atomically with the originals. `canUseSource` checks a specific source and
purpose; absent or legacy permissions deny use. It does not implement
authentication, visitor access control or permission changes.

## Partial scenes

Building a scene preserves the saved photograph and source metadata. The
selected box identifies a foreground candidate; its mask and the relative
depth are model proposals. Inspect them before relying on the spatial result.
The original camera view and a depth-inspection view make the limits visible.
The local viewer requires WebGL; the original memory remains readable when
it is unavailable.

On a wide desktop with enough vertical space, the scene stays beside the
scrolling editor. Narrow or short views use a single column. The photo credit
and the limits of the reconstruction stay beside the scene; selected-object
photo evidence can be expanded in the editor. Layout changes preserve the
camera and unsaved preview.

Page scrolling starts enabled over the scene. Choose **Explore in 3D** to
drag, zoom or use arrow keys, and choose it again to return to page scrolling.
The toggle's pressed state identifies the current mode. Original and side
view buttons remain available in either mode.

Reconstruction jobs are stored separately with source IDs and checksums.
Derived textures strip image metadata and retain a relation to their original.
Only completed, validated outputs are served. One model process runs at a time
to bound memory. Jobs time out after three minutes, and unfinished jobs found
after a restart become interrupted. A repeated request ID with the same input
reopens the original job; a deliberate retry after failure uses a new ID.

Foreground controls create a preview. **Apply and save** checks the saved
version and persists an offset and rotation before reporting success. An old
base version is refused; saving the same request again does not create another
version. The source surface and background remain unchanged. This is manual
editing of inferred visible surfaces; no historical layout or collision check
is claimed.

| Endpoint | Purpose |
|---|---|
| `GET /api/drafts/<id>/sources/<source>/image-size` | Stored pixel dimensions for a permitted original photo, independent of EXIF rotation |
| `POST /api/drafts/<id>/reconstructions` | Start or reopen a job using `requestId`, `sourceId` and pixel `box` |
| `GET /api/drafts/<id>/reconstructions` | Saved jobs, newest first |
| `GET /api/drafts/<id>/reconstructions/<job>` | One job and its saved transform |
| `GET /api/drafts/<id>/reconstructions/<job>/assets/<name>` | A validated derivative of a ready job |
| `POST /api/drafts/<id>/reconstructions/<job>/edit` | Save `requestId`, `baseVersion`, `offset` and `yaw` |

Two-object scenes use the request shapes in [the two-object guide](OBJECTS.md).

These controls coordinate one local server process. They do not implement
multi-process locking, power-loss durability or the full spatial editing
contract.

## Memory-driven proposals

A ready scene can use a written memory and its source photo to ask Meta for
one bounded change to the selected foreground. The photo needs both place
and model permission and must be marked as public material in this development
version. Sending the new message and a metadata-free thumbnail requires an
explicit checkbox. Use public or synthetic material only.

The hosted planner is disabled by default. An operator must supply
`MODEL_API_KEY` securely in the server environment and explicitly set
`REHERE_MODEL_LIVE=1` for that process. Never place credentials in browser code,
source files or command arguments. The local Python setup also prepares a
whole-photo JPEG thumbnail of at most 1024 pixels on its long edge and 1 MiB.
It receives no API credentials.

The adapter uses Spark Standard (`muse-spark-1.3`) through the fixed Meta
Responses endpoint with structured output, `store: false`, no tools and no
automatic retries. It counts the same input before generation, rejects counts
above 20,000, then reserves counted input plus the 4096-token output ceiling.
Default local limits are $0.05 per generation, $1 total and 20 generations.
`REHERE_MODEL_TOTAL_USD` and `REHERE_MODEL_MAX_REQUESTS` can lower those limits.
Reservations survive restarts in `data/model-budget.json`; unknown outcomes
retain their reservation. Recorded costs are estimates, not billing receipts.
These limits coordinate one process and are not provider-enforced spending
caps. Check current account credits and usage before each live batch.

The model can propose translation, rotation, a visible-surface direction toward
a candidate photo point, or a clarification question. The server validates
references, version, shape and coordinate bounds and computes the transform.
Human memories, model proposals and source pixels retain separate records.
The proposed facing direction uses an assumed camera frame and inferred depth;
it does not recover the object's physical front or historical orientation.
Review the target point and direction arrow before confirming the relation.
The blue direction line stays level with the object's centre; a separate grey
line connects it to the inferred target height. Only the upright-axis turn is
proposed.
Collision and fixed-relation validation are not implemented.

Preview changes only the display. Apply saves the approved transform, proposal
state and version receipt together. A changed base version requires a new
review. Cancel prevents later output from becoming applicable. Returning to an
earlier saved position creates a new version and preserves intervening history,
statements and originals. Provider failure produces an explicit failed state;
there is no prerecorded or local keyword-parser substitute for a model call.

All routes below extend `/api/drafts/<id>/reconstructions/<job>`:

| Endpoint | Purpose |
|---|---|
| `POST /proposals` | Request a plan with `requestId`, `baseVersion`, `text` and explicit `consent` |
| `GET /proposals` | Saved statements and proposal states |
| `GET /proposals/<proposal>` | Poll one proposal |
| `POST /proposals/<proposal>/cancel` | Cancel using `requestId` |
| `POST /proposals/<proposal>/apply` | Apply with `requestId`, `baseVersion` and `frontConfirmed` |
| `GET /history` | Initial position and saved changes |
| `POST /undo` | Restore `targetVersion` through a new version, using `requestId` and `baseVersion` |

For the provider contract see the official [Responses documentation](https://dev.meta.ai/docs/protocols/responses),
[structured output](https://dev.meta.ai/docs/structured-output),
[image input](https://dev.meta.ai/docs/image-understanding) and
[pricing](https://dev.meta.ai/docs/pricing-rate-limits). `store: false` controls
response storage and is not a zero-retention guarantee. Credit-program terms
and account privacy controls must be checked before using nonpublic material.

Three.js uses the MIT license; its notice is supplied with the package and
served at `/vendor/THREE-LICENSE`. The project license remains undecided.

## Upload limits

These are transport limits, not the final upload-validation
policy. Supported formats, decoding checks and processing failures still need
to be decided against the processing pipeline.

| Item | Limit and check |
|---|---|
| Whole request | 64 MiB, counted while streaming and before multipart parsing |
| Photos | Up to 20, 20 MiB each, JPEG or PNG by file signature; HEIC is refused |
| Voice | One recording, 50 MiB, WebM, Ogg or MP4 container by signature |
| Text | 10,000 characters before trimming; whitespace-only text is empty |
| Empty save | Refused unless there is a photo, text or a recording |

An intake plan also limits aggregate original bytes to 64 MiB. Its create and
plan-update JSON bodies are limited to 512 KiB; each file has the limits above.
An empty planned file fails individually without losing received files.

The five-minute recording length is enforced in the browser only. File content
is checked by signature, not decoded.

Requests are refused unless the `Host` header names `127.0.0.1` or `localhost`
on the server's port, and POST requests are refused when `Origin` names another site.
Responses carry a restrictive Content Security Policy and `nosniff`.
All private content routes require the workspace owner session, including
original files, derivatives, history, HEAD and byte-range requests.

## Development

`public/recorder.js` holds the recording state machine with the browser
microphone and `MediaRecorder` APIs injected, so tests use fakes and a test
page can supply a synthetic stream. `test/` covers the recorder lifecycle,
including late or replaced permission answers, and the server's storage,
persistence across restarts, limits, malformed input, path handling and storage
failure. `public/latest.js` keeps an earlier saved-memory request from
replacing the one opened last. A real microphone grant is not covered by
automated tests.

[The synthetic relation fixture](demo/README.md) freezes window/door and
clarification expectations before inference. Its drawing is a technical test,
not evidence of memory accuracy or consumer value.
