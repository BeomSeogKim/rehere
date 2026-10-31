# Recollections, alternatives and time

An invitation enrolls a separate contributor for a particular saved place.
Possessing the invitation does not give access to owner originals, editing,
other contributors' submissions or sharing controls. A display name is an
attribution label, not proof of a real identity or relationship. Keep the
separate access and recovery card described in [the access guide](ACCESS.md).

## Submit and review

A contributor chooses a ready scene and submits written recollection with
separate place-construction, model-processing and visitor-sharing grants.
These start off. An optional description of the time as remembered stays an
attributed claim; it does not set a capture date or create an era. This first
contribution path accepts writing. Photo and recording contributions are not
yet supported.

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

A changed saved version requires another review. An unconfirmed response keeps
the prepared request for an exact retry; reusing a request ID with different
input is refused. Switching views or signing out clears temporary previews.
Rendering failure is not counted as a completed spatial preview.

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

Only the providing principal can withdraw their contribution. Closing an old
invitation does not erase that principal or remove this right. Key recovery
preserves the identity. Withdrawal redacts the wording from subsequent API
responses and prevents further use. It does not claim to erase copies already
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
There is no multi-process coordination or power-loss guarantee. Visitor links,
recording playback across eras, model-assisted contribution review and general
multi-view reconstruction are separate unfinished features.
