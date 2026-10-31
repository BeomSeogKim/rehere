# Two objects and one relationship

A scene can be built from one photograph with exactly two named objects
instead of one selected foreground. Each object can then be moved and turned
on its own, and the owner can declare one explicit left/right relationship
between them. This is manual arrangement of model-inferred visible surfaces
from a single viewpoint, not a scene graph, collision check or recovered
historical layout. Scenes built with one foreground box are unchanged.

## Build and confirm

Draw two boxes on a permitted photo and give each a name of 1 to 80
characters. Names are your labels, not model identification, and must differ
ignoring case. The server keeps them as `object-1` and `object-2` in the order
given. Local depth estimation runs once and SAM2 proposes one mask per box.

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
planned, reviewed, given stories or shared. A wrong outline needs a new build
with different boxes; it is never corrected automatically.

## Arrange and relate

A saved arrangement holds a transform for each object and at most one rule.
Moving or turning one object changes only that object; the other object, the
background and the source files stay as they were. Every save, rule change and
restoration creates a new whole-arrangement version, so history, comparison,
undo and visitor views keep both transforms and the rule together.

The only rule is "keep A left of B from the original photo". It compares the
centres of the two visible surfaces, after each object's own move, as seen
from the original camera position. Turning an object about its own centre
does not change the check. A centre too close to or behind the original
camera cannot be compared, and the rule then refuses the change. A save that
breaks the current rule is refused and the last saved version stays intact.
Adding, changing or removing the rule is its own explicit, confirmed save.
Restoring an earlier version whose rule differs needs a separate confirmation.

## Planning, recollections and stories

A memory proposal names one confirmed object. The planner sees both objects
and any rule as context, but its answer may only change the named object; the
server refuses a plan for any other object. The planner is instructed to ask a
clarifying question when the memory names the other object, is ambiguous, or
asks to face the other object. A facing direction must point at background in
the photo, not at either object or an unassigned pixel. The server merges the
plan into the whole arrangement and checks the rule before offering it and
again before applying it. Changing the selected object never retargets an
existing plan. Any new version makes older plans stale.

Adopting a recollection or keeping it as an alternative also names the object
it positions. The server places that transform into the current whole
arrangement and keeps the rule; a contribution cannot clear the rule. If the
rule blocks adoption, the recollection remains as submitted.

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
| `POST /<job>/objects/confirm` | `requestId`, `objectIds: ["object-1", "object-2"]` |
| `POST /<job>/edit` | `requestId`, `baseVersion`, `targetId`, `offset`, `yaw` |
| `POST /<job>/relationship` | `requestId`, `baseVersion`, `relationship` (rule or `null`), `confirmed: true` |
| `POST /<job>/undo` | `requestId`, `baseVersion`, `targetVersion`, `ruleChangeConfirmed` |
| `POST /<job>/proposals` | the existing fields plus `targetId` |

Recollection review transforms and new stories add `targetId` the same way.
One-foreground scenes keep their original request shapes and return their
original single transform. The worker's `surface.json` version 2 stores the
two objects and a region per grid cell (unassigned, background, object 1 or
object 2), alongside the existing depth grid and camera assumptions.
Visitor views receive only the geometry, regions, object names and source
boxes needed to draw and identify the objects.

This covers exactly two objects in one photograph and one left/right rule.
More objects, other rules, physical collision, multiple viewpoints and
automatic object identification are not implemented.
