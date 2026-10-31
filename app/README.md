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
- **Save** reports success only after the server has stored every file. A
  failed save keeps all selected photos, writing and the recording for retry.
  When the response is lost, the page says it cannot confirm the save and
  asks the person to check the saved list before retrying.
- Saved memories are listed and can be reopened to view photos, read the text
  and play the recording. Saved memories cannot be edited.

Each photo, written memory and recording has its own source details: provider
label, origin/reference, and separate permissions for place construction,
model processing and visitor sharing. Permissions start off. Provider labels
are attribution, not verified identity, and selecting a permission does not
start processing or publish anything.

Saved photographs with both place-construction and model-processing permission
can be used to build a partial scene. Select a foreground box, review the
inferred depth and mask, explore the visible surfaces, and preview a foreground
move or rotation before saving it. Unseen areas stay empty. This is a local
model reconstruction from one photograph, not a complete room or calibrated
geometry.

Not included: transcription, multi-view alignment, natural-language spatial
editing, sharing, accounts, and recovery of unsaved input.

## Getting started

Requires Node.js 26 or later. Three.js is pinned for the spatial viewer.

```sh
cd app
npm ci --ignore-scripts --no-audit --no-fund
npm start   # http://127.0.0.1:4317/ (set PORT to change it)
npm test
```

The server listens on the loopback interface only. Saved memories are written
to `app/data/`, which is ignored by Git. Delete that folder to remove them.

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

## Original sources and dates

New drafts use `schemaVersion: 2` and contain a `sources` array. Each original
gets a server-generated source ID, kind, SHA-256 checksum, byte count and its
source details. Photo and voice entries refer to those records through
`sourceId`; `textSourceId` identifies the written original. Meaningful written
text is preserved as received, including whitespace, and hashed as UTF-8.
Multipart string fields normalize line breaks to CRLF during transport; the
checksum describes that received original. No derived copy replaces an
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

These controls coordinate one local server process. They do not implement
multi-process locking, authentication, sharing, undo history, power-loss
durability or the full spatial editing contract.

Three.js uses the MIT license; its notice is supplied with the package and
served at `/vendor/THREE-LICENSE`. The project license remains undecided.

## Upload limits

These are transport limits for this endpoint, not the final upload-validation
policy. Supported formats, decoding checks and processing failures still need
to be decided against the processing pipeline.

| Item | Limit and check |
|---|---|
| Whole request | 64 MiB, counted while streaming and before multipart parsing |
| Photos | Up to 20, 20 MiB each, JPEG or PNG by file signature; HEIC is refused |
| Voice | One recording, 50 MiB, WebM, Ogg or MP4 container by signature |
| Text | 10,000 characters before trimming; whitespace-only text is empty |
| Empty save | Refused unless there is a photo, text or a recording |

The five-minute recording length is enforced in the browser only. File content
is checked by signature, not decoded.

Requests are refused unless the `Host` header names `127.0.0.1` or `localhost`
on the server's port, and saves are refused when `Origin` names another site.
Responses carry a restrictive Content Security Policy and `nosniff`.

## Development

`public/recorder.js` holds the recording state machine with the browser
microphone and `MediaRecorder` APIs injected, so tests use fakes and a test
page can supply a synthetic stream. `test/` covers the recorder lifecycle,
including late or replaced permission answers, and the server's storage,
persistence across restarts, limits, malformed input, path handling and storage
failure. `public/latest.js` keeps an earlier saved-memory request from
replacing the one opened last. A real microphone grant is not covered by
automated tests.
