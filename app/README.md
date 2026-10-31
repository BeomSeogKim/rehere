# Rehere memory entry

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

Not included: transcription, provider and permission records, derived copies,
date handling, sharing, accounts, recovery of unsaved input, and place
generation.

## Getting started

Requires Node.js 26 or later. There are no package dependencies.

```sh
cd app
npm start   # http://127.0.0.1:4317/ (set PORT to change it)
npm test
```

The server listens on the loopback interface only. Saved memories are written
to `app/data/`, which is ignored by Git. Delete that folder to remove them.

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

## Upload limits

These are transport limits for this endpoint, not the final upload-validation
policy. Supported formats, decoding checks and processing failures still need
to be decided against the processing pipeline.

| Item | Limit and check |
|---|---|
| Whole request | 64 MiB, counted while streaming and before multipart parsing |
| Photos | Up to 20, 20 MiB each, JPEG or PNG by file signature; HEIC is refused |
| Voice | One recording, 50 MiB, WebM, Ogg or MP4 container by signature |
| Text | 10,000 characters after trimming |
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
