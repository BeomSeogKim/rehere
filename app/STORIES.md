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
saving. Captions may instead start from an [AI draft](#draft-captions-with-ai). Version numbers do not establish a date. A changed time assertion
requires refreshing and explicitly reviewing the context again.

By default the playback copy contains the complete first audio track. To use
an excerpt, choose its start and end in the original recording. These are
integer millisecond positions; the end must be after the start and within
the decoded recording. The range stays bound to that original's checksum,
the chosen object and the saved view. Captions and playback start at 0:00 of
the selected part. Changing the recording or selection clears the caption
acknowledgment so it can be reviewed again.

The local decoder reads the whole first track once, then an excerpt keeps
exactly the selected samples. Only those samples enter its playback copy;
no outside audio is delivered through its story route. The copy is mono
16 kHz, 16-bit PCM WAV. Other tracks are not included. The original remains
unchanged. Recordings over five minutes are rejected even when a shorter
excerpt was requested. It accepts supported WebM, Ogg and MP4 containers;
MP4 files requiring seeking may fail because input is pipe-only. No file or
network protocol fallback is attempted. Set `REHERE_FFMPEG` to a prepared
FFmpeg executable if it is not available on `PATH`.

Saving waits for conversion and application storage. A failure does
not create a story. If confirmation is lost, retain and retry the unchanged
request to reconcile it; a busy response does not prove failure. There are
no automatic retries. A saved story is immutable: a correction or new context
requires another explicitly saved story. Withdraw an old story to stop its use.

## Draft captions with AI

For a whole recording of at most 60 seconds, the owner can ask Muse Voice
Transcribe for a caption draft instead of starting from nothing. It is offered
only when the recording's provider allowed model processing, and the recording
is sent only after a second, explicit confirmation. Its spoken turns become
editable cues with their start and end times. Silent turns are dropped; turns
that overlap, run out of order or end more than 100 ms past the recording
reject the whole draft rather than being repaired. Nothing else is chained to
the draft: it never starts a scene proposal.

A draft is bound to the recording's checksum, the chosen saved view and
revision, and in a two-object scene the object the story will be about. The server checks the story context and the recording's model use
when the request is admitted, immediately before sending and before returning
the draft; a withdrawal or restriction during the request discards the answer.
The draft text is returned once and not kept, so a lost draft must be requested
again or written by hand.

The draft lands in the caption editor unconfirmed. A draft that arrives after
the recording, view, part or captions changed is not applied, and editing
drafted captions clears the confirmation again. Saving sends the draft's ID; the
server accepts it only for a successful draft of the same whole recording,
view and object. The saved story then credits its captions as AI-drafted by Muse Voice
Transcribe and reviewed by the owner, for the owner and in shared visits. That
credit is part of the shared story's pinned content, so changing it suspends
the visit. Stories saved without a draft keep their earlier record and pin.

## Listen and read

Playback starts only after a Play action. Pause and Stop are separate controls;
all captions remain readable as a transcript. The currently active cue is
identified with text rather than color alone. Captions are human supplied, or
an AI draft reviewed by the owner and credited as such; they are not
independently verified. Confirming captions
means they convey the selected playback's meaningful audible content; unrelated
commentary does not substitute for captions.

An excerpt player names its original start and end and explains the 0:00
playback origin. Earlier whole-recording stories stay whole and are not
rewritten or clipped. Changing a selection requires a newly saved story.

Only one recording plays at a time, including original-recording playback and
recorder listen-back. Switching arrangement, leaving, hiding the page, signing
out or losing permission stops playback and clears pending audio. Resuming a
stopped view requires fresh authorization and another explicit Play action.
Selecting a story does not force a camera movement.

If the browser reports a playback error, the player clears its local audio
and current-caption marker and offers Play again. That explicit retry fetches
the recording with current access checks; it never retries automatically.

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
application decisions. Unreviewed automatic captions, contributor-recording excerpts,
inferred story matching and arbitrary track selection are not included.

One server process owns this local workspace. Power-loss durability, hosted
operation and operating-system audio isolation are not claimed.
