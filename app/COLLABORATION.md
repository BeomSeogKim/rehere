# Recollections, alternatives and time

An invitation enrolls a separate contributor for a particular saved place.
Possessing the invitation does not give access to owner originals, editing,
other contributors' submissions or sharing controls. A display name is an
attribution label, not proof of a real identity or relationship. Keep the
separate access and recovery card described in [the access guide](ACCESS.md).

## Submit and review

A contributor chooses a ready scene and submits writing, a recording, or both,
optionally with one JPEG or PNG. A photo alone is insufficient. Each present
material has separate place-construction, model-processing and visitor-sharing
grants, all initially off. An optional description of the time as remembered
stays an attributed claim; it does not set a capture date or create an era.

Recording offers Record, Stop, listening and Discard. No microphone request is
made until Record is pressed, and declining it does not block writing or photo
submission. The recorder stops at 4:59; decoded audio must fit within five
minutes and 50 MiB. A photo and recording together must also fit within the
64 MiB request limit. Changing places stops capture. A take and its facts stay
with their original place; another place starts without that take or its grants.

The server checks the actual WebM, Ogg or MP4 bytes through one strict local
decode. The immutable original stays private; a separately checksummed 16 kHz
mono WAV is used for listening. No audio or captions are sent to a model.
Optional human-written listening captions stay separate from the recording
and independent writing. They are not automatic or verified transcription.
Private submission and listening work without captions; visitor sharing needs
confirmed captions.
The provider can listen again from their own received-contributions list;
the owner has a separate private review player. Neither starts automatically.

After receipt, the provider can add listening captions or correct their own
captions. Confirm the new wording explicitly. Each save creates an attributed
version and keeps prior captions privately available to the owner and provider.
The original recording, listening copy and independent written recollection
remain unchanged. Only the providing person can make this change; the owner
cannot rewrite another person's captions.

A caption change stops existing visitor snapshots that included that recording.
Returning to the earlier words creates another version and does not revive an
old link. The owner must select the current captions, preview and issue a new
snapshot. Already delivered copies cannot be recalled. Historical spatial
reviews and geometry remain unchanged; a later caption difference is labelled
separately from what the owner reviewed at the time. An old review without a
recorded caption binding is labelled unknown.

A rejected or unconfirmed caption save keeps the typed draft. An exact retry
uses the prepared request, even after later typing. After reload, only an
opaque request ID remains: check its receipt instead of recreating the old
request from new text. A confirmed older save is distinguished from newer
current captions. Concurrent edits use the current caption binding and refuse
a stale change rather than overwrite it. Caption history is limited to twenty
versions per contribution. Withdrawal removes all caption versions from later
responses; it does not claim physical deletion of private stored records.

A photo keeps its immutable original and a separate inspection JPEG, with
checksums and a source relationship. Attribution comes from the signed-in
provider. Source type, reference, asserted capture date, file dates and an
estimated period stay separate; unknown dates remain unknown. The photo belongs
to the contribution and is never added to the owner's imported originals.
It does not become a reconstruction or hosted-image input.

Photo submission accepts up to 20 MiB and 32 million pixels. The local decoder
checks JPEG/PNG content and prepares an inspection copy with a long edge of
at most 2048 pixels and at most 2 MiB. It applies display orientation, flattens
transparency on white and removes EXIF, XMP, ICC, comments and text metadata.
Re-encoding can change colours and pixels. Visible people and text remain;
this is not anonymization. Private review and visitor evidence serve this copy,
never the original file.
16-bit PNGs using a transparency colour key are refused until their full
precision can be preserved; export those as JPEG or 8-bit PNG for inspection.

Submission preserves the original wording, checksum and authenticated provider
identity. It does not modify the saved scene. The owner can mark a submission
as under review, hold it, reject it, adopt it, or preserve it as an alternative.
Owner review notes are private because they can mention other people's private
material. Contributors receive the fixed outcome and linked reconstruction
identifier, rather than those notes. Rejection never deletes other accepted
material or rewrites the provider's words.

For adoption or an alternative, the owner manually positions and turns the
selected foreground and previews it in the actual scene. This review path does
not interpret the sentence with a model. Adoption saves the reviewed transform,
new version, attribution and decision together. An alternative saves its own
immutable transform and parent version, leaving the current scene unchanged.
The photo, inferred surface and human recollection keep their separate roles;
owner approval does not certify historical truth. In a two-object scene the
owner chooses which named object the recollection positions; the result keeps
the other object's transform and the current relationship rule, and a rule it
would break blocks adoption. See [two objects](OBJECTS.md).

For a photo-backed correction or alternative, the owner also explicitly
acknowledges reviewing the contributed photo. The photo, contributor's words
and owner's manual interpretation remain distinct. This does not automatically
match the second image to an object, register its camera or recover a measured
position. A different viewpoint can be held for review without inventing an era.

A recording-backed correction or alternative additionally needs an explicit
listening acknowledgment. The interface enables it after playback successfully
starts; this does not prove completed listening, attention or historical truth.
Unavailable material can still be held or rejected. An owner can separately
link an eligible recording to selected visitor views and an object or the whole
place, without changing geometry. That narrative association does not claim
the recording informed the reconstruction.

A changed saved version requires another review. An unconfirmed response keeps
the prepared request for an exact retry; reusing a request ID with different
input is refused. Switching views or signing out clears temporary previews.
Rendering failure is not counted as a completed spatial preview.

An uncertain submission keeps its request ID. The page checks the provider's
own submissions after a reload before starting another. Browser persistence
contains only scoped pending IDs, never writing, photos or source settings.
An uncertain attempt keeps its exact input only while the page remains open.
After reload, recovery can only look up its receipt; current form contents
cannot recreate the earlier request. Sending new material requires an explicit
new submission with a new request ID; the earlier outcome may remain unknown.
Closing the page aborts client requests but does not prove accepted server work
was cancelled.

## Alternatives and explicit time

Comparison switches between saved reconstructions in the same photograph's
coordinate frame. An alternative is a different account, not automatically an
earlier or later era. Candidate conflict labels such as viewpoint, time,
recollection or recognition do not decide which account is correct.

An owner can separately confirm an exact date, a date range, a relative label
such as "before renovation", or leave time unknown. The assertion keeps its
own author, original wording and revision. A relative label does not become an
invented year. A same-time relationship does not establish a chronology or
merge two alternatives. Changes append assertions rather than rewriting a
contributor's original time claim.

## Grants and withdrawal

Every spatial change inherits its supporting contribution IDs. Place permission
is required to use a recollection manually. Hosted processing also requires
model permission for every inherited contribution, because a transform can
carry information from that memory even without its words. Sharing permission
is recorded separately; having an edited scene is not a sharing grant.

Writing, photo and recording form one reviewed bundle. Construction, model
processing and visitor sharing require the corresponding grant from every
present material; absent writing has no
writing grant. Hiding a photo, omitting a quotation or selecting only the
recording does not remove the bundle's restrictions. Component withdrawal is
not supported; the provider withdraws the whole bundle.

Only the providing principal can withdraw their contribution. Closing an old
invitation does not erase that principal or remove this right. Key recovery
preserves the identity. Withdrawal redacts writing and captions from subsequent
API responses, blocks listening copies and prevents further use. It does not claim to erase copies already
downloaded or remove private stored originals from disk.

Dependent alternatives become unavailable. If the current scene depends on the
withdrawn contribution, its spatial use is blocked at the server, including
asset reads, new changes and hosted proposals. A small manual adjustment,
changed label or generic review acknowledgment cannot remove dependencies.
Restore a demonstrably unaffected saved version as a new version to resume;
the intervening history stays intact. Later visitor snapshots must apply the
same current grants and withdrawals even when their versions are fixed.

## Operation

These records use the existing reconstruction manifest and mutation queue.
Adoption and withdrawal publish one atomic manifest within one server process.
There is no multi-process coordination or power-loss guarantee. Referenced
photo and recording files are checked when the manifest is read; successful
hashes may be reused while the file identity, size and nanosecond modification/change times
stay unchanged. Corruption with an unchanged stat identity can escape that
cache until restart. Serving an inspection image or recording always checks
its bytes.
Unavailable media files block dependent uses without claiming a
provider withdrawal. Repaired files can be checked again.
One contribution-media preparation runs at a time; another request receives a
busy response. A published exact retry reuses its receipt without decoding
again. Photo and voice preparation are sequential outside the scene mutation
queue; their files and contribution publish together.
Model-assisted contribution review and general multi-view reconstruction remain
unfinished.
