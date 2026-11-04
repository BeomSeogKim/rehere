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
identifier, rather than those notes. The owner can separately write a short
message for that contributor and, for an adoption or alternative, explicitly
choose to show the reviewed object's name. Neither choice is preselected or
filled from a private note. The review form previews the exact outgoing
message and name before saving. Rejection never deletes other accepted
material or rewrites the provider's words.

This feedback is visible only to the owner and the providing contributor.
The captured name describes the reviewed part at that decision; later object
renames do not rewrite it, and it is not a claim about the current scene or
historical truth. Reviewing, holding and rejecting can carry a message without
a part name. No message or name is added to visitor packets, stories or model
inputs, and no notification is sent.

The review request accepts optional `feedback: {showTarget, note}`. `showTarget`
is a boolean; `note` is plain text of at most 500 UTF-16 code units. The form
uses the trimmed note in both its preview and request. An explicit empty or
whitespace-only message with `showTarget: false` is refused; omit `feedback`
to keep the ordinary decision. `showTarget: true` is accepted only for an
adoption or alternative and can accompany an empty note. The server captures
the validated target's confirmed name, or `Selected foreground object` for a
single foreground; a client cannot provide a replacement label.

New feedback needs current source and contributed-material access. Later
withdrawal, unavailable material or blocked linked arrangements hide saved
feedback, including on receipt replays. Physical contribution deletion removes
it from retained review records. Existing decisions without feedback retain
their request and response shapes; private review reasons remain private.

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

New two-object adoptions and alternatives retain the object the owner chose.
The owner's list names it as the subject of that decision, not an automatic
interpretation of the contributor's words. Earlier adoptions can recover it
only from an exact retained contribution/version receipt. An earlier
alternative without that record keeps its object unknown; transform or text
similarity does not establish the association. Existing records are not
rewritten to add this information.

From a chosen object's **Sources**, open its relevant recollections in this
same list. **Show all** keeps unassigned submissions and unknown older records
reachable. Filtering does not select a review or replace its typed fields,
acknowledgments, prepared retry or scene preview. The target association is
owner-only metadata. Only an explicitly chosen, captured part name can be
included in that contributor's review feedback; the internal target identity
and an issued visitor snapshot remain unchanged.

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
input is refused. While a review save is unconfirmed, its fields and outgoing
feedback stay locked to that request. Changing the viewed object cannot change
the held disclosure or retry payload. Switching views or signing out clears
temporary previews.
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

## Revise a saved reconstruction

Show a saved reconstruction, then choose **Make a revised alternative**.
Choose an object, adjust its position or turn, choose the new alternative's
time explicitly, and preview before saving. The new **Owner revision** starts
from that selected parent's complete arrangement, even if the main scene has
changed since. The other object, relationship rule, coordinate frame and
relative scale stay exactly as the parent saved them. This path does not
change scale or generate geometry.

Saving creates an immutable child alternative. It leaves the parent, current
main version, original material, contribution wording and earlier stories or
visitor snapshots unchanged. A child can be compared, revised again, or
explicitly selected for a new story or visitor snapshot. Its owner-facing
lineage identifies the parent and changed object; it is not a rewritten
contributor statement. Visitor evidence keeps the original recollection's
recorded object, while the arrangement's origin identifies a manual owner
change.

Start with time unknown, or explicitly confirm the parent's current known
time statement again. The latter creates a new owner assertion, retaining
any relative-time reference rather than inventing a year or moving that
reference to the child. If the parent's time changes after preview, review
it again before saving. A missing or unavailable relative reference cannot
be silently dropped to make confirmation succeed.

The preview context and save both verify the original photos, derived files,
current place use and every inherited contribution dependency. Model
permission is unnecessary for this deterministic operation. The parent's
relationship and actual named-surface checks still apply. An unchanged
arrangement is refused, including equivalent turn endpoints. Each scene can
keep at most 200 owner revisions; an exact retry still resolves its earlier
child at that limit.

An unconfirmed response keeps the exact prepared request for retry, rather
than starting another child. A confirmed save remains saved if the following
list refresh or scene display fails. A newer view or edit choice is not
replaced by a delayed save completion.

All routes below extend `/api/drafts/<id>/reconstructions/<job>`:

| Request | Purpose |
|---|---|
| `GET /variants/<parent>/revision-context` | Owner-only verified parent arrangement, current time assertion and its revision |
| `POST /variants/<parent>/revisions` | Save `requestId`, `baseEraRevision`, `transform`, `timeMode` and `confirmed: true` |

`timeMode` is `unknown` or `reconfirm-parent`. A single foreground uses
`transform: {offset, yaw}`; two objects from one photo add `targetId`;
a composition uses `{targetId, pose: {position, quaternion}}` and retains the
parent's exact scale. There is no main `baseVersion`: the selected parent is
the authority. A new child returns the raw variant with 201; an exact replay
returns the same child with 200. Reusing a request ID with a different parent
or body is refused. Current source and dependency checks also gate replay.
Only new revision variants add owner metadata
`revision: {parentVariantId, targetId, timeMode}`; older variants keep their
existing shape. Private lineage is not added to visitor packets.

The existing current-main asset restriction still applies: when the main
version depends on withdrawn material, the shared scene assets are blocked
even for an independently usable alternative. Restore an unaffected saved
version before rendering it. Relative-time reference usability is checked
when confirming the relation and selecting it for sharing; later withdrawal
of that referenced alternative does not currently invalidate the child's
local time assertion or a local story context automatically.

## Revise an alternative from a remembered instruction

Inside **Make a revised alternative**, choose **Remembered instruction**
instead of manual placement. Choose the object and the new alternative's time,
write a complete instruction and explicitly consent to model processing.
Planning uses that selected parent's saved arrangement, not an unsaved manual
preview or the current main scene. Reviewing a stored proposal shows its own
object and time choice; it is never retargeted by newer controls.

The hosted planner needs current model permission for every geometry source
and inherited contribution, in addition to place use. Source photographs must
be marked as public material during development. The request contains the
owner's new instruction, permitted photo selections and the parent's named
object poses and relationship. Parent time wording, contributor statements
and recordings are not automatically sent. Dates written in the instruction
do not change the selected unknown or explicitly re-confirmed time.

A clarification creates no child. Answer it with a complete revised
instruction and a new request; no conversation is automatically uploaded.
A ready result must preserve the parent's other objects, rule, coordinate
frame and relative scale, pass the visible-surface checks and be previewed in
3D before saving. A facing action also needs an aligned direction guide and
explicit confirmation of the photographed side. A full turn with no final
pose change is refused rather than saved as a new arrangement.

Approval stores the validated result as one immutable child, together with
the proposal's applied state and request receipt. The client cannot substitute
a different transform. Main, parent, originals and previous stories or
snapshots stay unchanged. Main advancing does not change this plan's target;
a changed parent time requires a new review. Source restrictions, withdrawal,
deletion and shutdown stop further dispatch and prevent late results from
being offered or saved.

An uncertain create, cancel or save keeps its exact request. New previews and
first saves stay paused until that action is resolved. A committed save's
exact retry returns the same child even after a later parent-time change or
model-off, provided its current place use, files and dependencies remain
usable. New saves still require model permission. A created child can be
viewed under place use after model processing is turned off. Reloaded applied
proposals open their existing child rather than offer another save.

All routes extend `/api/drafts/<id>/reconstructions/<job>` and require the owner:

| Request | Purpose |
|---|---|
| `POST /variants/<parent>/proposals` | Plan with `requestId`, `baseEraRevision`, `targetId`, `timeMode`, `text` and `consent: true` |
| `GET /variants/<parent>/proposals` | Inspect this parent's stored proposals |
| `GET /variants/<parent>/proposals/<proposal>` | Read one scoped proposal |
| `POST /variants/<parent>/proposals/<proposal>/cancel` | Cancel using `requestId` |
| `POST /variants/<parent>/proposals/<proposal>/apply` | Save with `requestId`, `baseEraRevision`, `frontConfirmed` and `confirmed: true` |

The single-foreground target is `selected-foreground`; two-object scenes use
`object-1` or `object-2`. New plans return 202 and exact replays return 200.
The model echoes `parentVariantId` and `baseEraRevision`, including for
clarifications; there is no main `baseVersion`. A ready owner response includes
the full parent-based `candidate` with `version: null`. Apply returns
`{proposal, variant}` with 201, or 200 for the same committed child. Reusing an
applied proposal for another child is refused. Main and alternative proposal
routes do not accept each other's records.

Only model-assisted children add `revision.proposalId` to their owner
metadata, with an action to inspect the saved instruction. New visitor
snapshots identify their arrangement origin as memory-assisted; manual
revisions retain the manual origin. Neither the private proposal identifier
nor its instruction is automatically copied into visitor packets. Existing
packets are not rewritten.

### Plan from retained source words

The first submitted contribution creates a baseline of the current saved
scene. This is a stored starting arrangement, not a model generation. A partial
scene needs no separate full-object baseline request.

`GET /variants/<parent>/revision-context` also offers `statementSources`.
Each choice contains an opaque `statementSource`, exact retained `text`,
`attribution` and `modelAllowed`. Choices without model permission remain
readable but cannot be planned. Unavailable sources are omitted.

Instead of `text`, an alternative proposal can send one of these references:

```json
{"kind":"contribution-text","contributionId":"00000000-0000-4000-8000-000000000001","sourceSha256":"<exact text SHA-256>"}
```

```json
{"kind":"story-captions","storyId":"00000000-0000-4000-8000-000000000002","sourceSha256":"<joined caption text SHA-256>","storySha256":"<story content pin>"}
```

Send the whole discovered reference unchanged, with `sourceReviewed: true`
separately from `consent: true`. The owner must review those exact words;
neither acknowledgment applies a change. The server resolves the original
text, never a client replacement. Existing whole-place writing references
`{sourceId, sourceSha256}` and free instructions keep their earlier shapes.
This does not add source binding to the current-main free-text planner.

A contributed text must be submitted, adopted or an alternative, with intact
retained wording and current bundle grants. Its authenticated supplier label
does not establish the speaker or author. A story must have explicitly
confirmed captions and intact original voice, playback, saved context and
content pin. Caption text joins cues with a newline in their saved order;
the additional story pin binds their timing, voice and caption-draft credit.
The voice supplier, caption reviewer and model credit stay distinct.

The proposal stores its exact reference, text hash, owner acknowledgment and
attribution. The existing preview and apply contract creates one immutable
child. Every following child retains all typed source dependencies and actual
contribution IDs. New dispatch and apply need model grants; private display
needs place grants and new visitor selections need share grants. Withdrawal,
deletion, missing bytes or a changed bound story block descendants rather than
detach their origin. Main and the parent remain unchanged.

Visitor `evidence.arrangement` is `memory` for an applied proposal child.
`evidence.support` acknowledges contributing suppliers and reviewed stories
without copying their words. Contribution excerpts and story captions still
require their existing explicit sharing selections. Excerpts shared alongside
a view do not by themselves establish which exact words caused its change.
No private source, contribution, story or proposal identifiers are added to
public evidence.

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

## Delete a contribution locally

The providing person can separately choose **Delete from Rehere** for their
whole contribution, including one already withdrawn. Review the affected
material and uses, acknowledge that removal cannot be undone, then confirm.
If those uses change after review, review them again before confirming.
The owner cannot delete another provider's contribution through this control.

Access stops and linked content is redacted in one atomic manifest write.
Stored originals, inspection and listening copies are removed separately.
The interface distinguishes **access stopped, cleanup pending** from completed
removal. A failed cleanup stays pending; the same explicit retry or server
restart can resume it. An uncertain response never means that removal failed.
After reload, check the earlier operation rather than submit another deletion
automatically. Only an opaque pending request identifier is kept in the browser.

Removal covers the contribution's writing, material metadata, caption history
and attached review notes. It also clears app-tracked copies: affected visitor
previews and snapshots, linked variant labels and time wording, copied story
context labels, and dependent model proposal content. Affected visitor packets
stay stopped. The app retains only content-free processing records and the
dependency identifiers needed to keep saved geometry blocked and prevent old
requests or links from recreating removed content.

Other contributions and the owner's original photos, recordings, story captions
and independently written notes remain. Saved geometry and edit history remain
blocked where they depend on the removed contribution; an independent saved
arrangement can still be restored. Account profile information is separate.

Completed removal means removal from this app's tracked storage on this
computer. It does not erase copies already downloaded, viewed or screenshotted,
unlinked notes written elsewhere, previously emitted terminal logs, device
backups, freed disk blocks or anything already sent to a hosted service.
It is not secure erasure or a provider-retention guarantee. Unexpected files
or symbolic links in a contribution directory leave cleanup pending rather
than expand the deletion to arbitrary files.

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
The manual contribution review path does not call a model. Source-bound
alternative proposals are separate; general multi-view reconstruction remains
unfinished.
