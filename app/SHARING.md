# Saved visitor views

A visitor link opens a fixed saved snapshot without an account. It cannot edit
the place, submit recollections or open private originals. The current server
is loopback-only: links work on the same computer, not as an internet-hosted
product. No external publication occurs when testing a local link.

## Preview before issuing

Open a ready scene and expand **Share a saved view with visitors**. Choose a
title, the saved arrangements visitors may compare, which one opens first,
and any permitted recollections to quote. Label synthetic test material as
synthetic. Capture the camera from the actual scene, then preview the visitor
screen. Switching arrangements preserves that camera for comparison.

You can also select inspection photos contributed to one of the chosen
arrangements. A selected photo appears only with the views that depend on it;
it is labelled as contributor-supplied and not automatically matched or
verified history. The provider's original, source reference and raw date
metadata stay private. The inspection JPEG removes file metadata but still
shows visible people and text. Review the actual pixels before issuing a link.

A current saved version has unknown time. Explicitly selected immutable
alternatives can carry the owner's separate time assertion. If an assertion
relates one alternative to another, both must be selected. A disagreement does
not establish an earlier or later era. Photo evidence, inferred geometry and
human recollection remain separately labeled; none is verified history.

The photo and every supporting recollection need both place-construction and
visitor-sharing permission. Omitting a quotation does not remove the spatial
result's dependencies or bypass those grants. Recollections that allow manual
construction and sharing can be used without a model-processing grant; they
cannot thereby authorize later hosted processing.

For a contribution containing a photo, both the writing and photo need place
and share grants. Omitting the image does not make its dependent arrangement
independent or bypass either grant. Missing or corrupt contributed photos
also make their dependent snapshots unavailable.

The preview is an actual read-only visitor screen, not a live link. It expires
after fifteen minutes. Confirm that visitors may see the chosen reconstruction
and your own time assertions, then explicitly issue the link. A 2D fallback
requires separate confirmation and is never counted as a successful 3D preview.
The server issues exactly the stored preview and rechecks its current rights
and selected state atomically. A selected change or withdrawn dependency requires
a new preview. Another link requires another preview.

## Explore and compare

On a wide desktop, the scene stays beside the view choices, object evidence
and stories while the page scrolls. Smaller views use one column. Choose
**Explore in 3D** to control the camera, then choose it again to scroll the
page over the scene. Switching saved arrangements keeps the camera; selecting
an object shows its evidence and related stories without moving the camera.
Opening evidence or resizing the layout preserves the view and player state.

Photo attribution, synthetic labeling when applicable, and the limits of the
inferred surfaces stay beside the scene. The 2D fallback disables exploration
and remains a separate way to read the permitted material.

## Fixed content and current rights

A link lasts up to seven days or until revoked. It preserves its selected
transforms, source-derived assets, quotations, time assertions and camera.
Selected contributor inspection photos are pinned by checksum with the views
they support; later submissions do not silently replace them.
For a [two-object scene](OBJECTS.md) it keeps both objects' transforms and the
relationship rule of each selected arrangement, plus the owner's object names
and source boxes so visitors can tell the objects apart.
Later private edits do not publish themselves. The visitor sees the shared
date and a short saved-copy reference under the title.

Current rights override a fixed version. A supporting recollection's withdrawal
or denied use suspends the entire affected snapshot, even if its wording was
not quoted. A revised selected time assertion also suspends the old snapshot;
it is not silently relabeled. An unaffected historical snapshot remains usable
when an unrelated newer private reconstruction is blocked.

Every manifest and asset request checks the snapshot's own recorded dependencies
against current state. Visitor data uses an allowlist. Private filenames,
source references, IDs, checksums, review notes, history and unselected statements
are excluded. The visitor receives only the required geometry and a validated,
metadata-free photo texture. There is no raw-original download route. Sharing a
photo-derived scene necessarily shares the visible pixels in that texture.

## Links and uncertain outcomes

The browser prepares a random visitor token before issuing. The server stores
only its verifier. The token remains in the link fragment and authorization
header; it is not stored in browser storage or copied into server paths, query
strings or logs. Private responses use `Cache-Control: no-store`.

If issue confirmation is lost, repeat the unchanged prepared request. It returns
the same receipt and never creates a second snapshot. Changing the request ID's
contents is refused. The server cannot recover a lost plain link after reload.
Use the shared-view list to identify and revoke an uncertain copy before
intentionally issuing another. Old issue receipts never reactivate revoked
links, and retired tokens cannot be reused.

## Revoke and stop viewing

Revocation denies new page and asset requests after its acknowledgment, including
HEAD and range requests. The open visitor screen rechecks access every fifteen
seconds with a five-second timeout. Denial or failed checking removes the
renderer, texture and shared wording. Hidden pages pause immediately; resuming
requires fresh authorization. Late requests cannot reopen a stopped view.
Already delivered bytes or recordings made outside the app cannot be recalled.

Spatial views, permitted writing and explicitly selected [recorded stories with
captions](STORIES.md) can be shared. A story stays with its exact saved view;
private edits do not rebind it. Hosted operation is not connected. Owners can narrow
original-source grants or stop their use through [source controls](SOURCE-USES.md);
current restrictions override every affected frozen snapshot. One server process
owns the data directory; no multi-server or power-loss guarantee is claimed.
