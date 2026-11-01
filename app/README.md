# Rehere local app

A local web application for gathering the material behind a remembered place:
photographs, a written memory and an optional voice recording. Photographs and
writing are enough to save; the microphone is requested only when the person
presses Record, and declining it never blocks saving.

## What it does

- Optionally name a place for yourself and people invited to contribute. Rename
  it later without changing its original material or a visitor link's title.
  Unnamed places stay explicitly unnamed; names are never inferred.
- Add and remove photo previews, write a memory, and optionally record, stop,
  listen back to and discard a voice recording. Recording stops automatically
  just before five minutes (4:59), leaving room for encoder padding under the
  server's five-minute decoded-audio limit.
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
  Received files, text, the optional place name and source settings return;
  files that never reached the server must be selected again, removed or
  replaced. A missing recording
  needs a new take. Temporary received files are labelled as not saved yet.
- Saved memories are listed and can be reopened to view photos, read the text
  and play the recording. Original material is unchanged by a place rename;
  saved photos, writing and recordings cannot be edited through that control.

Each photo, written memory and recording has its own source details: provider
label, origin/reference, and separate permissions for place construction,
model processing and visitor sharing. Permissions start off. Provider labels
are attribution, not verified identity, and selecting a permission does not
start processing or publish anything. Current grants can be narrowed or stopped
through [source use controls](SOURCE-USES.md), without rewriting the originals.

The owner can separately review and remove a whole saved place, including its
local contribution copies. Access stops before file cleanup is confirmed;
unclear requests and pending cleanup remain explicitly recoverable. Other
places and account credentials stay separate. See [local place removal](PLACE-DELETION.md)
for confirmation, retry and the copies outside its scope.

Saved photographs with both place-construction and model-processing permission
can be used to build a partial scene. Select a foreground box, review the
inferred depth and mask, explore the visible surfaces, and preview a foreground
move or rotation before saving it. Unseen areas stay empty. This is a local
model reconstruction from one photograph, not a complete room or calibrated
geometry. A scene can instead hold exactly two named objects that are confirmed,
moved and related separately; see [two objects](OBJECTS.md).

Scoped contributors can submit writing, a real recording, or both, with an
optional photo. Each material retains its own original, source facts and
default-off uses. Photo inspection uses a metadata-stripped copy; recordings
use a locally decoded listening copy. Human-written listening captions are
optional for private review and required for explicitly selected visitor audio.
Providers can later add or correct their listening captions while keeping the
original recording and previous caption versions. Existing links using the
recording stop; corrected words need a new explicit visitor preview and link.
Owners can preview a manual change, adopt it or preserve an alternative, and
record a separate explicit time assertion. Recordings can also be linked to a
visitor view and object or place without changing geometry. Withdrawal blocks
dependent uses. Providers can separately review and confirm removal of their
whole contribution from this app's tracked local storage. Access stops first;
file cleanup has a separate pending or completed state. Previously delivered
copies, backups and hosted-service retention remain outside that removal.
See the [collaboration guide](COLLABORATION.md) for grants,
review and restoration.

Recorded stories connect a permitted imported recording to an explicitly chosen
saved arrangement and its foreground object, or one named object of a
two-object scene. Use the whole first audio track or explicitly select an
excerpt by its start and end in the original. The original stays unchanged;
caption times start at 0:00 of the selected playback. Human-supplied captions
and provider attribution accompany the converted copy, with explicit
visitor selection and current withdrawal checks. See [recorded stories](STORIES.md).

Not included: automatic transcription, multi-view alignment, hosted account
integration, and recovery of input that never reached the server.

Saved visitor snapshots can include selected arrangements and permitted written
recollections. Preview the actual visitor screen before issuing a local link;
later private changes stay private, while current withdrawal overrides a frozen
copy. See the [sharing guide](SHARING.md) for access, revocation and limits.
In a 3D visit or preview, compare the permitted photo copy with the selected
reconstruction from the same original viewpoint, then return to your previous
camera. Labels keep source pixels, chosen positions and inferred surfaces
distinct; comparison stops story playback and never edits a saved arrangement.
A visit hidden in another tab is cleared at once and re-authorized on return;
it then reopens the same saved view, object and camera when that saved copy and
those choices are unchanged, with audio stopped and photos collapsed.

The saved-place screen puts the scene workspace first. Original photos,
writing, recordings and source-use controls remain under **Original materials
and allowed uses**. Opening that disclosure keeps the scene and camera in
place. A memory without a photo opens its materials for inspection.

Opening a scene updates its local address to
`#/memories/<memory-id>/scenes/<scene-id>`. Reloading or reopening that address
checks the same scene and its current access rules. It does not choose another
build or recover an unsaved preview or selected alternative. Build and photo
choices remain explicit under **Build or choose another scene**; navigation
does not start inference, change grants or issue a visitor link. A blocked or
unfinished scene keeps its own status rather than opening a substitute.

## Getting started

Requires Node.js 26 or later. Three.js and three-mesh-bvh are pinned for the
spatial viewer and named visible-surface checks.
Set up the local workspace owner and retain its private access card using
[the access guide](ACCESS.md) before signing in. No web visitor can create or
claim the owner account.

```sh
cd app
npm ci --ignore-scripts --no-audit --no-fund
npm start   # http://127.0.0.1:4317/ (set PORT to change it)
npm test
```

The private server listens on the loopback interface only. An optional
[visitor-only ingress](VISITOR-INGRESS.md) adds a separate loopback port for
saved visits behind an independently operated HTTPS proxy; account and editing
routes remain private. No proxy or public deployment is configured by the app.
Saved memories and workspace authority are written to `app/data/`, which is
ignored by Git. Deleting that folder removes both, including any access card
kept inside it. Keep a separate secure copy of the current card.

Saving a photo requires Pillow in the selected Python environment. The
[photo-checking-only setup](spatial/README.md#photo-checking-only) needs no
model weights. Saving a recording requires local FFmpeg, found on `PATH` or
selected for this process
with `REHERE_FFMPEG`. These checks run locally and do not load model weights or
send files to a provider. If photo checking is not set up, complete that setup
before saving again. An unavailable or busy checker keeps already received
files in place; saving again retries the missing file.

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
| `POST /api/drafts` | Multipart fields `text`, `photos` (repeatable), `voice` and optional `placeName` |
| `GET /api/drafts` | Summaries, newest first |
| `GET /api/drafts/<id>` | One saved memory with current private place metadata |
| `POST /api/drafts/<id>/place-name` | Owner rename or clear using `requestId`, `baseRevision` and `name` |
| `GET /api/drafts/<id>/assets/<name>` | A file listed in that memory; supports byte ranges |

The optional name is mutable owner metadata in `drafts/<id>/place.json`,
separate from `draft.json`, originals and source-use policy. A named creation
publishes that sidecar in the draft's single staging-directory rename. No file
means unnamed, including old drafts; naming does not migrate their source
records. Owner responses include the current name, its revision and an explicit
unavailable state if that sidecar cannot be read. An unreadable optional name
does not hide unrelated originals or other places.

Renames check their name revision and preserve each successful request receipt,
including no-ops. Retrying an exact request never reapplies an old name over a
later change; the response identifies the processed revision and current name.
A conflict or unclear result keeps the typed input for explicit review or the
same-request retry. Renaming does not remount a scene or discard its unsaved
preview. These are single-process, atomic-file guarantees, without fsync.

Authorized contributor and owner-invitation choices identify the place by its
name and existing photo/scene context. IDs remain the authoritative hidden
selection values. Names are not sent to a model, inferred from material or
copied into visitor payloads. Visitor titles remain separate explicit input;
renaming never rewrites a previously issued snapshot.

The entry screen first creates an owner-private unfinished save under
`data/intakes/<id>/`. Adding a file does not upload it; only Save starts the
transfer. Each planned original has a stable part ID, byte count and SHA-256.
Files are validated and acknowledged separately. Updating a plan checks its
revision and keeps received parts with unchanged identities; changed originals
need new IDs and start with no uses allowed. File names and modification times
are display hints, never paths or source dates.

| Endpoint | Purpose |
|---|---|
| `POST /api/intakes` | Start or reopen the same explicit Save using `requestId`, raw `text`, `parts`, `metadata` and optional `placeName` |
| `GET /api/intakes` | Open unfinished saves, newest first |
| `GET /api/intakes/<id>` | Current progress or a terminal saved/discarded receipt |
| `POST /api/intakes/<id>/parts/<part>` | Send one planned original as `application/octet-stream` |
| `GET /api/intakes/<id>/parts/<part>` | Received bytes of an active part of an open save; supports ranges |
| `POST /api/intakes/<id>/plan` | Update text, optional name, settings and active parts using `requestId` and `baseRevision` |
| `POST /api/intakes/<id>/commit` | Commit all received originals using `requestId` and `baseRevision` |
| `POST /api/intakes/<id>/discard` | Explicitly discard temporary progress using `requestId` |

Finalization rechecks the originals and atomically stores one ordinary draft
with a private receipt. A lost response or a process restart resolves to that
same draft. Terminal intake routes return identifiers and receipts only;
content goes through the saved draft's current source-use controls. Temporary
part access ends even when cleanup fails. Open progress has no automatic
expiry; explicitly discard it when no longer needed. Browser storage holds
only opaque pending IDs scoped to the owner, never names, text, files or source details.
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
editing of inferred visible surfaces; no historical layout is claimed.
Two-object arrangements additionally check intersections between the two
named visible surfaces before saving. See [the two-object guide](OBJECTS.md)
for contact handling, bounded checks and the geometry that remains unknown.
One-foreground scenes do not have that intersection gate.

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
Two-object plans also keep the explicit left/right rule and pass the named
visible-surface gate before being offered and applied. These checks do not
recover hidden geometry or establish physical clearance.

Preview changes only the display. Apply saves the approved transform, proposal
state and version receipt together. A changed base version requires a new
review. Cancel prevents later output from becoming applicable. Returning to an
earlier saved position creates a new version and preserves intervening history,
statements and originals. Provider failure produces an explicit failed state;
there is no prerecorded or local keyword-parser substitute for a model call.

A collapsed "Saved proposals" list shows every stored proposal with its
target, request time (or "time unknown"), status and the start of its
statement. Reviewing one is local: nothing is sent, planned or previewed, and
the review states that the response was stored earlier with its model, not
newly generated. Choosing another ends any preview, so the guide and front
check are done again. Choosing is blocked while an action runs, while any
planning is queued or processing (that planning stays reviewable), or while
a request outcome is still unknown. A redacted proposal shows only a fixed
notice. A reviewed proposal that leaves the list is cleared, and no other is
chosen in its place.

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
served at `/vendor/THREE-LICENSE`. The MIT notice for three-mesh-bvh is served
privately at `/vendor/THREE-MESH-BVH-LICENSE`. The project license remains
undecided.

## Upload limits

Both the resumable entry screen and the legacy multipart endpoint check the
actual file content before accepting a new original. Decoded pixels and audio
are discarded; the original bytes and their checksums remain unchanged.

| Item | Limit and check |
|---|---|
| Whole request | 64 MiB, counted while streaming and before multipart parsing |
| Photos | Up to 20, 20 MiB each, JPEG or PNG, fully decoded within 32 megapixels; HEIC is refused |
| Voice | One recording, 50 MiB, WebM, Ogg or MP4, with a decodable first audio track of at most 300 seconds |
| Text | 10,000 characters before trimming; whitespace-only text is empty |
| Place name | Optional one-line label, up to 120 UTF-16 units before trimming; not source material |
| Empty save | Refused unless there is a photo, text or a recording |

An intake plan also limits aggregate original bytes to 64 MiB. Its create and
plan-update JSON bodies are limited to 512 KiB; each file has the limits above.
An empty planned file fails individually without losing received files.

PNG checks include chunk checksums. Animated PNGs and 16-bit PNGs with a
transparency colour key are refused; export a single still image as JPEG or
8-bit PNG. Grayscale, CMYK and progressive JPEG are accepted. Dimensions use
stored pixel order; validation does not rotate or rewrite the original.
Pillow tolerates some JPEG corruption and trailing bytes, so acceptance means
the image decodes with this decoder, not forensic proof of an intact file.

Recordings are decoded to 16 kHz mono samples locally. Silence is valid; an
empty or unreadable audio track is refused. Error-level decoder output causes
refusal even if the process exits successfully. Input validation normalizes
decoded PCM timestamps from sample counts, without changing the samples, so a
valid browser recording is not refused for an output-muxer timestamp warning.
Extra tracks are not checked.
Pipe-only MP4 decoding cannot seek to a remote index; some end-index files may
need to be recorded again. Short samples and samples lasting about five minutes,
generated with an oscillator through Chrome WebM and Safari WebM/MP4
MediaRecorder, exercise encoding compatibility; they are not
real microphone tests. Firefox remains unverified. The browser stops at 4:59,
but a delayed timer can still
produce an overlong file that the server refuses.

One owner-input validation runs at a time; there is no queue. A temporary
checker failure does not mark a file damaged. A permanent failure marks only
that file and offers a replacement step. Private per-part validation records
bind the current policy to its kind, type, size and checksum. Old open uploads
without a current record are checked before their received bytes can be
restored or committed. A matching validated retry does not need a decoder
again. Existing committed memories are not migrated or revalidated.

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

Most domain HTTP tests inject a media verifier so synthetic signature-only
fixtures exercise storage and permissions without requiring a codec runtime.
The verifier tests and `spatial/test_verify_owner_photo.py` cover the actual
content-checking boundary; real decoder checks report when a runtime is
unavailable. They are distinct from fake-fixture domain coverage.

[The synthetic relation fixture](demo/README.md) freezes window/door and
clarification expectations before inference. Its drawing is a technical test,
not evidence of memory accuracy or consumer value.
