# Two objects and their relationships

A scene can be built from one photograph with exactly two named objects
instead of one selected foreground. Each object can then be moved and turned
on its own, and the owner can declare one explicit left/right relationship
between them. This is manual arrangement of model-inferred visible surfaces
from a single viewpoint, not a scene graph or recovered
historical layout. Scenes built with one foreground box are unchanged.

## Compose objects from two photos

Under **Build or choose another scene**, choose **Compose objects from two
photos**. Select exactly two saved objects from different photos of this
place: a ready foreground, or a confirmed object from a ready two-object
scene. A composition cannot be used as another composition's input. Give
the objects distinct names, then preview their position, full orientation
and assumed relative scale before saving.

Each object keeps its own photographed texture and nonplanar visible mesh.
Position, orientation and relative size are your assumptions, not measured
dimensions, automatic photo alignment or a recovered historical layout.
The first photo's observed background is kept by default, fixed at the first
object's initial placement. An optional source-pixel rectangle excludes
unwanted background margins without cropping either object. The second
photo's background is not imported. With context off, only the two observed
surfaces are shown; there is no reconstructed room behind them.

Saving creates a separate scene without copying parent edits, recollections,
stories or links. Inspect the source surfaces and explicitly confirm both
their identity and your assumed layout. Each object can then move, tilt,
turn, roll and change relative scale independently. Reset returns it to its
recorded initial pose. Saved versions, restoration, recollection alternatives,
eras, stories and visitor views retain both complete poses and any rule.
Later movement of the first object never moves the fixed background.

Coordinates belong to one owner composition frame, independent of either
source camera and the camera used to explore. A left/right rule compares
centres on that frame's X axis. To point one photographed side toward the
other object, preview the direction and explicitly choose that side as the
face to point; the app does not identify a semantic front automatically.
Saving a persistent facing rule is a separate explicit action. Coincident
centres or a direction without a stable upright orientation are refused.

The same named-surface overlap check applies. Deterministic reuse requires
current place use for both original photos, without model permission.
Fresh hosted proposals require both model grants and send both permitted
photo contexts. Model plans may translate, turn around the common vertical
axis, point at the other object or ask a question; they preserve relative
scale. Recollection review also preserves scale. Only a manual edit changes it.

Source inspection is object-specific: each object has its own photo, box
and attribution. There is no combined original photograph to compare with.
A photographed-side view is an inspection vantage, not an exact photo
projection. Visitors receive both permitted textures and the selected saved
poses, with each photo's evidence kept separate. Restricting either source
blocks the whole dependent scene and its visitor snapshots, even if that
object is offscreen. Originals and earlier scenes remain unchanged.

Saved layouts and comparisons describe left/right, height, front/back,
photographed-side direction and assumed relative size in words. Directions
use the fixed owner layout, independent of the viewing camera. Small changes
remain visible in the description; these words are not physical measurements
or historical claims. The same descriptions remain available in the 2D fallback.

Selecting an object in a composition visit also shows the recollections
recorded as supporting that object in the selected saved view. Attribution
does not mean a recollection was the only basis for the layout, or grant its
words for sharing. Older snapshots without a recorded object keep that
association unknown. Changing the saved view updates the evidence together.

## Build and confirm two objects from one photo

Draw two boxes on a permitted photo and give each a name of 1 to 80
characters. Names are your labels, not model identification, and must differ
ignoring case. The server keeps them as `object-1` and `object-2` in the order
given. Local depth estimation runs once and SAM2 proposes one mask per box.

Optionally, the server can be started with SAM 3.1 (Meta Model API) outlines
instead of local SAM2 (`REHERE_SEGMENTATION=sam-3.1`; see
[`app/spatial/README.md`](spatial/README.md)). Each object's name is then sent,
with the exact original photo, to Meta's API as one concept prompt, and only
while the photo's model use is allowed, which is checked again before each request.
The server keeps the single returned outline whose box matches the owner's
box (intersection over union at least 0.5, and at least 0.15 above any
other); a weak or near-tied match fails the build instead of guessing. The
model's confidence is recorded but never used to choose. Depth stays local.
The scene, its build status and visitor snapshots name SAM 3.1 (Meta Model
API) as the outline source; the selection, response ID and request digest are
kept with the scene. All other limits below apply unchanged.

Pixels claimed by both masks are left unassigned, as holes that belong to
neither object nor the background. If they exceed 1% of the smaller mask, the
build fails and asks for boxes that separate the objects. Each object must
cover 1% to 50% of the depth grid, both together at most 60%, and each object
and the background must keep at least 32 renderable triangles; otherwise the
build fails rather than producing an unreadable object. Unseen sides and
anything behind the objects stay empty.

A finished build is a model proposal. The mask overlay tints each object and
marks unassigned pixels in white; the page names each object in text, so
colour is not the only cue. Inspect both outlines, then confirm that each is
the object you named. Until then the scene can be viewed but not edited,
planned, reviewed, given stories or shared. A wrong outline can be corrected
by hand before confirmation, or replaced by a new build with different boxes;
it is never corrected automatically.

## Correct an outline

Before confirming a two-object scene, choose **They do not match** to repair
one object's outline on the photo copy used for the scene. The overlay and
cutout show the actual depth-grid cells, so a brush stroke has that precision,
not the original photo's resolution. Add can take background or unassigned
cells; Remove returns the chosen object's cells to photographed background.
Removing a cell added from an unassigned area restores it to unassigned.
Neither operation can change the other object's cells. Undo or reset before
choosing the other object. Arrow keys move the cell cursor and Space paints.

Refresh the 3D preview and inspect its original and side views. The preview
reuses the existing depth and photo texture. It cannot fix depth errors,
recover hidden surfaces or fill a gap behind a moved object. An outline that
looks right from the photo can still have jagged or stretched geometry from
another viewpoint. Inspect the result before deciding to keep it.

**Save as new scene** creates a separate, unconfirmed scene at the photo's
original positions. Both objects start with zero move and turn, without a
relationship rule. The previous scene, its saved arrangements, stories and
links stay unchanged; they are not copied to the new scene. Review both new
outlines before the usual confirmation. An unclear save response pauses
painting and can repeat the exact request without making another copy.

This is deterministic image processing with Pillow in the configured
`PHOTO_PYTHON` environment; it runs no depth or segmentation model and needs
current place use, without model-processing permission. The source photo,
previous assets, texture and depth preview remain unchanged. A new mask,
overlay, surface and summary receive their own hashes. Existing object
coverage, usable-triangle and depth checks still apply and can reject a
correction. No failed correction replaces the previous scene.

To include the real producer integration tests in the Node suite, run
`PHOTO_PYTHON=/path/to/pillow-python npm test` from `app/`. Without an
explicit interpreter that imports Pillow, that suite is omitted; a passing
default run does not verify the producer.

Corrected scenes and newly issued visitor snapshots say that their outlines
include an owner-made correction, while depth remains a model estimate.
That label does not establish history or imply that every object's outline
was manually changed. Existing snapshots keep their original data and labels.

## Link regions from other photos

After confirming both objects, choose one and open its **Sources**.
The object's box in the scene photo can be compared with regions you mark in
other original photos of this same place. Draw a box, inspect both photos,
and explicitly confirm that they show the same object. If unsure, leave
them unlinked. There is one region per reference photo for each object;
change its region or remove the link to correct your judgment.

These links record your assessment. Rehere does not recognise or align the
photos, establish their dates, infer another viewpoint or change the scene.
The boxes use stored pixel coordinates, without applying EXIF rotation.
Reopening the scene restores its links; an unsaved arrangement stays in
place while a link is saved. A conflict keeps the drawn input for explicit
review, and an unclear answer can repeat the same prepared request.

A reference needs current permission for place construction, but not model
processing. The normal build still requires both. Stopping or removing place
use makes that reference unavailable, with its box hidden; it does not delete
the record or the original. An unavailable reference link can be removed
while the scene itself remains usable. Stopping the scene's own photo blocks
the scene and its links. Source-use controls count stored linked regions;
if that optional metadata cannot be read, the count is explicitly unknown
and source restriction remains available.

Links are owner-private metadata in a separate `region-links.json` beside
the scene manifest. Each object's revision and request receipts are
independent of arrangement versions. A link change never rewrites the
manifest, original photos, source-use policy or an issued visitor snapshot.
Contributors, visitors and model requests receive no link data. A missing
sidecar means no links; an unreadable one reports unavailable without
disabling the ordinary scene. This uses one process and atomic file writes,
without fsync or multiple-process locking.

## Link the original written memory

In the selected object's **Sources**, review the saved written memory and
confirm that its words are about this object. This links the entire original
writing; it does not edit the words or create a new model proposal. Both
objects may be linked to the same writing. The link is your judgment, not
automatic recognition, a time assertion or a change to the arrangement.

The writing needs current place use, without model or sharing permission.
The server checks the original text's checksum before showing it here.
Stopped, restricted or changed writing leaves an unavailable link without
its words. The link can still be removed while the scene remains usable.
Removing the link keeps the original writing. Missing source details cannot
be replaced by invented grants.

Links reopen from a separate `memory-links.json` beside the scene manifest.
Each object has its own revision and request receipts. Saving a link keeps
the scene, unsaved placement and original materials unchanged. An uncertain
answer can repeat the exact prepared request; a conflict needs a fresh review.
These owner-private links are excluded from model requests and visitor views.
Whole-place removal includes their stored metadata.

The same Sources disclosure can open the existing saved-proposal,
recollection and recorded-story lists for the chosen object. Each jump
refreshes that list before filtering it by its recorded object identifier.
**Show all** restores the place-wide list, including records whose object
was not recorded. An unreadable list is not reported as an empty result.
These are reading controls: they do not choose a proposal, apply a change,
retarget a form or start playback. Unsaved placement and typed input stay.

## Arrange and relate

A saved arrangement holds a transform for each object and at most one rule.
Moving or turning one object changes only that object; the other object, the
background and the source files stay as they were. Every save, rule change and
restoration creates a new whole-arrangement version, so history, comparison,
undo and visitor views keep both transforms and the rule together.

For a scene built from one photo, the rule is "keep A left of B from the
original photo". It compares the
centres of the two visible surfaces, after each object's own move, as seen
from the original camera position. Turning an object about its own centre
does not change the check. A centre too close to or behind the original
camera cannot be compared, and the rule then refuses the change. A save that
breaks the current rule is refused and the last saved version stays intact.
Adding, changing or removing the rule is its own explicit, confirmed save.
Restoring an earlier version whose rule differs needs a separate confirmation.

Before a new arrangement is saved, the editor and server check whether the
two named photographed surfaces overlap. This uses the actual drawn triangles,
including their holes and depth discontinuities, rather than their boxes or
centres. Positive-area coplanar overlap and interior surface penetration hold
the change; boundary-only contact is allowed. An unfinished or unreadable
check also holds the change. Numerically uncertain contact, including contact
on an internal triangle seam, is held rather than treated as clearance. The
saved version stays intact and the preview can be adjusted.

The same gate covers manual edits, rule saves, model proposals, recollection
adoption, alternatives and restoration. Existing historical arrangements are
kept as recorded; restoring one is a new checked change. This tests only the
two named visible surfaces. Background intersections, hidden backs, solid
volumes, a movement's path and physical room boundaries are not checked. The
relative depth is an estimate, so a clear result is not physical clearance.

To refine a saved alternative without changing the current scene, use
[owner revisions](COLLABORATION.md#revise-a-saved-reconstruction). They keep
the selected parent's other object, rule and relative scale.

## Planning, recollections and stories

A memory proposal names one confirmed object. The planner sees both objects
and any rule as context, but its answer may only change the named object; the
server refuses a plan for any other object. The planner is instructed to ask a
clarifying question when the memory names the other object, is ambiguous, or
asks to face the other object in a single-photo scene. In that representation,
a facing direction must point at background in
the photo, not at either object or an unassigned pixel. The server merges the
plan into the whole arrangement and checks the rule and named surfaces before offering it and
again before applying it. Changing the selected object never retargets an
existing plan. Any new version makes older plans stale.

Adopting a recollection or keeping it as an alternative also names the object
it positions. The server places that transform into the current whole
arrangement and keeps the rule; a contribution cannot clear the rule. If the
rule or surface check blocks adoption, the recollection remains as submitted.

A story on a two-object scene names its object explicitly, and the story list
and evidence show which one. Stories are never moved to the other object or
to a later arrangement. Visitors can pick an object to filter its stories;
switching objects stops the playing recording. Stories on one-foreground
scenes keep their original foreground.

## Interfaces

All routes extend `/api/drafts/<id>/reconstructions` and keep the existing
authority, source-use and contribution checks.

| Request | Body |
|---|---|
| `POST` (build) | `requestId`, `sourceId`, `objects: [{label, box}, {label, box}]` |
| `POST` (compose) | `kind: "two-photo-composition"`, `requestId`, two `objects` with `label`, `component: {jobId, objectId, surfaceSha256}` and `pose`, `context: {keep, bounds}`, `confirmed: true`, `scaleBasis: "owner-assumed-relative"` |
| `POST /<job>/objects/confirm` | `requestId`, `objectIds: ["object-1", "object-2"]` |
| `POST /<composition>/objects/confirm` | `requestId`, both `objectIds`, `surfaceIdentityConfirmed: true`, `layoutConfirmed: true`, `scaleBasis: "owner-assumed-relative"` |
| `POST /<job>/outline-corrections` | `requestId`, `sourceSurfaceSha256`, `targetId`, `regions`, `confirmed: true` |
| `POST /<job>/edit` | `requestId`, `baseVersion`, `targetId`, `offset`, `yaw` |
| `POST /<composition>/edit` | `requestId`, `baseVersion`, `targetId`, `pose: {position, quaternion, scale}` |
| `POST /<job>/relationship` | `requestId`, `baseVersion`, `relationship` (rule or `null`), `confirmed: true` |
| `POST /<job>/undo` | `requestId`, `baseVersion`, `targetVersion`, `ruleChangeConfirmed` |
| `POST /<job>/proposals` | the existing fields plus `targetId` |
| `GET /<job>/variants/<parent>/revision-context` | Verified owner revision context; see [owner revisions](COLLABORATION.md#revise-a-saved-reconstruction) |
| `POST /<job>/variants/<parent>/revisions` | `requestId`, `baseEraRevision`, one-object `transform`, `timeMode`, `confirmed: true`; see [owner revisions](COLLABORATION.md#revise-a-saved-reconstruction) |
| `GET /<job>/objects/<object>/region-links` | Current owner links and their availability |
| `POST /<job>/objects/<object>/region-links` | `requestId`, `baseRevision`, `action` (`set` or `remove`), `sourceId`, `box` (or `null` for removal), `confirmed: true` |
| `GET /<job>/region-reference/<source>` | Place-permitted reference dimensions in stored pixel order |
| `GET /<job>/objects/<object>/memory-link` | Current owner link to the whole saved writing, with permitted words and availability |
| `POST /<job>/objects/<object>/memory-link` | `requestId`, `baseRevision`, `action` (`set` or `remove`), `sourceId`, `confirmed: true` |

Recollection review transforms and new stories add `targetId` the same way.
One-foreground scenes keep their original request shapes and return their
original single transform. The worker's `surface.json` version 2 stores the
two objects and a region per grid cell (unassigned, background, object 1 or
object 2), alongside the existing depth grid and camera assumptions.
Visitor views receive only the geometry, regions, object names and source
boxes needed to draw and identify the objects.

An outline correction accepts at most 2 MiB of JSON and binds the complete
region map to the parent surface hash and one target object. A new ready
scene returns 201; an exact replay returns the same scene with 200. Reusing
the request ID with different input returns 409. Corrected owner manifests,
surfaces and public packets add `outline: {kind: "owner-corrected"}`; legacy
scenes omit it. Private parent identifiers and replay digests stay private.

Compositions use surface schema 3 and exactly `surface.json`, `texture-1.jpg`
and `texture-2.jpg`. Their whole arrangements record `frame:
"owner-composition"` and each object's position, unit quaternion and relative
scale. The initial arrangement is stored explicitly. Public packets use
object-specific `sourceIndex` and `evidence.photos`, without private source or
parent identifiers. New composition `evidence.support` entries include the
recorded public `objectId`, or `null` when it cannot be established from the
review and variant lineage. Quoted words still require explicit selection
and current permission. Single-photo representations keep their existing shapes.

These representations cover exactly two named objects. More objects, physical
solid collision, automatic multi-view alignment and automatic object identity
confirmation are not implemented. Neither representation establishes history.
