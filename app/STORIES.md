# Recorded stories

Attach an imported recording to an explicitly selected saved arrangement and
its foreground object. In a [two-object scene](OBJECTS.md) the story names one
of the two objects; it is never moved to the other object, and visitors can
filter stories by object. Stories on one-foreground scenes are unchanged.
The recording provider stays separate from the person
who supplies captions. These are attributed accounts, not verified history.
Synthetic audio fixtures must be identified as tests; a tone is not a person's
memory or evidence of speech intelligibility.

## Save a story

A recording needs current place-use permission to be used privately. It does
not need a model-processing grant for deterministic local audio conversion.
Choose the saved version or alternative, review its time assertion if any,
write captions for the meaningful audible content, and confirm them before
saving. Version numbers do not establish a date. A changed time assertion
requires refreshing and explicitly reviewing the context again.

The playback copy contains the complete first audio track, converted to mono
16 kHz, 16-bit PCM WAV. Other tracks are not included. The original remains
unchanged. The decoder rejects recordings over five minutes instead of
silently cutting them. It accepts supported WebM, Ogg and MP4 containers;
MP4 files requiring seeking may fail because input is pipe-only. No file or
network protocol fallback is attempted. Set `REHERE_FFMPEG` to a prepared
FFmpeg executable if it is not available on `PATH`.

Saving waits for conversion and application storage. A failure does
not create a story. If confirmation is lost, retain and retry the unchanged
request to reconcile it; a busy response does not prove failure. There are
no automatic retries. A saved story is immutable: a correction or new context
requires another explicitly saved story. Withdraw an old story to stop its use.

## Listen and read

Playback starts only after a Play action. Pause and Stop are separate controls;
all captions remain readable as a transcript. The currently active cue is
identified with text rather than color alone. Captions are human supplied and
not automatically transcribed or independently verified. Confirming captions
means they convey the recording's meaningful audible content; unrelated
commentary does not substitute for captions.

Only one recording plays at a time, including original-recording playback and
recorder listen-back. Switching arrangement, leaving, hiding the page, signing
out or losing permission stops playback and clears pending audio. Resuming a
stopped view requires fresh authorization and another explicit Play action.
Selecting a story does not force a camera movement.

## Share selected stories

Select stories explicitly in the saved visitor preview. Each must belong to a
selected arrangement, and both the recording and the scene's dependencies need
current visitor-sharing permission. The preview uses the same player and
converted audio as the visitor. It shows the provider, caption author, captions
and arrangement before link issue.

Private edits do not rebind a saved story or publish a new one. Its exact
version, transform, supporting recollections and applicable time assertion are
frozen. Current source restrictions, supporting withdrawals, story withdrawal
or a changed bound time assertion override the frozen snapshot. Stopping a
voice source affects its own stories and snapshots, not unrelated scene uses.
Stopping the primary photo blocks every dependent arrangement and story.

Visitor audio is fetched through the snapshot's explicit story allowlist and
token authorization before becoming a local Blob URL. Tokens are never audio
query parameters, and visitors have no original-recording route. New page,
audio, HEAD and range requests honor current restrictions. The existing visit
heartbeat also removes playback on denied or unconfirmed access. Previously
delivered audio cannot be remotely erased.

## Decoder boundaries

The subprocess receives only stored bytes through stdin with a fixed allowed
container and pipe protocol, emits bounded raw samples through stdout, and
runs with fixed arguments and a small environment. The app writes its own
fixed WAV header; original metadata, chapters, video and attachments are not
copied into that playback file. Limits cover input/output size, elapsed time
and sample duration. Original hashes and the derivative hash are recorded
separately. This is not an operating-system decoder sandbox or voice
anonymization: spoken information and the voice itself remain identifying.

See the official [protocol](https://ffmpeg.org/ffmpeg-protocols.html) and
[format](https://ffmpeg.org/ffmpeg-formats.html) documentation for the transport
and raw PCM controls. The selected limits and storage/permission checks are
application decisions. Hosted transcription, contributor recordings, excerpt
editing, inferred story matching and arbitrary track selection are not included.

One server process owns this local workspace. Power-loss durability, hosted
operation and operating-system audio isolation are not claimed.
