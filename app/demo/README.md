# Demonstration fixtures

Run these commands from the repository root. If the quickstart left you in
`app/`, return to the repository root first with `cd ..`.

## Current visit: New York's original Penn Station

The visit uses [Cervin Robinson's April 24, 1962 photograph of the main
concourse](https://commons.wikimedia.org/wiki/File:Main_concourse_of_Pennsylvania_Station,_New_York_City_on_April_24,_1962.jpg),
HABS NY-5471, photograph 8. The source JPEG SHA-256 is
`80a4e27ca08caf3d3ad9e90df603725584e42c3ab8ae2addf39dc4c4b1b5a026`.
Credit: Cervin Robinson, 1962. HABS NY-5471. U.S. Government work. No known
restrictions on images made by the U.S. Government.

Local SAM 2.1 outlines the clock and local depth produces partial surfaces.
No SAM 3.1 outline is used in this scene. The photograph viewpoint remains
recognizable, but even a small camera move exposes torn edges and empty areas.
These are limits of the reconstruction, not recovered parts of a complete room.

Saved version 1 is the original orientation and has the synthetic story.
Muse Voice Transcribe drafted its captions; the demonstration owner corrected
a duplicated phrase before saving them. The voice is synthetic macOS
text-to-speech, not a witness. Saved version 2 has the demonstration hypothesis
about the clock: Muse Spark (`muse-spark-1.3`), response
`resp_6aeb2351b74e8530803c4fc0`, proposed the change, the owner previewed it and
approved the save. The saved turn is -0.1745 radians (about -10 degrees) with
zero translation. Its sign is a scene coordinate, not a historical assertion
about which direction the clock faced. The story remains attached only to
Saved version 1.

The frozen snapshot is `99787631-6b65-4e9d-a24d-02ac00d2b154`; original view
`ed8fa175-109b-4a16-aabf-b0bca84c47c5`, changed view
`dacbf03a-71cf-4bb3-ba1f-0f1a7c804404`. The public copy is read-only and does not
follow later revocation or withdrawal. The [static guide](../STATIC-DEMO.md)
describes that boundary. No real recollection or consumer validation is claimed.

## Earlier example: Grand Canyon Lodge

Grand Canyon Lodge on the North Rim was destroyed in the July 2025 Dragon Bravo
Fire, according to the [National Park Service](https://www.nps.gov/grca/northrimstatus.htm).
Richard Frear's July 1982 survey photograph shows the main lodge's recreation
room looking east: rows of chairs sit beneath exposed beams and hanging lights.
The [HABS caption index](https://tile.loc.gov/storage-services/master/pnp/habshaer/az/az0400/az0459/data/az0459cap.pdf)
identifies it as AZ-135-A-19; the [photograph record](https://www.loc.gov/pictures/item/az0459.photos.321989p/)
identifies the source. A [separate detail photograph](https://www.loc.gov/pictures/item/az0459.photos.321990p/)
shows a wall light in the same room, but the captions do not establish which
fixture it is in the wider view or how the photographs align.

### Wicker chest and rocking chair (photograph 26)

The [HABS caption index](https://tile.loc.gov/storage-services/master/pnp/habshaer/az/az0400/az0459/data/az0459cap.pdf)
catalogs AZ-135-A-26 as "Wicker chest and rocking chair", by the same
photographer in July 1982. It shows those two pieces of furniture against trees
and grass. It is not a view of the lodge rooms, and nothing here reconstructs
the lodge. The [credit file](habs-az-135-a-26.credit.txt) holds its source and
rights line: a U.S. Government work with no known restrictions on images made
by the U.S. Government, per the Library of Congress advisory. That line belongs
only to a snapshot made from this photograph.

1. **Save the photograph** with its source and deliberately chosen uses.
2. **Name the two objects** ("Rocking chair", "Wicker chest") and build a
   two-object scene as described in
   [two objects from one photo](../OBJECTS.md#build-and-confirm-two-objects-from-one-photo).
   Inspect the result against the photograph. It is a partial model estimate
   with gaps; judge it by what the inspection shows, not by this guide.
3. **Move one object by hand** and save the change as a new version. Label it as
   the demonstrator's hypothesis, for example "For this demonstration, move the
   wicker chest a little left". It is not a recollection, a witness account, or
   evidence of where the furniture stood.
4. **Optionally compare a model proposal.** The planner is off by default, and a
   live call needs an operator to enable it; without it, use the manual change.
5. **Preview and share.** The visitor sees the saved versions with the
   photograph, the model estimate and the hypothesis kept distinct. A frozen
   copy of that snapshot can be exported as in [the static guide](../STATIC-DEMO.md),
   with `--credit-file app/demo/habs-az-135-a-26.credit.txt`.

If the demonstration includes the owner note as audio, it is a **Synthetic demo
voice (macOS text-to-speech)** reading a demonstration instruction about the
photograph. Label it that way; it is not a person, a memory or a witness
account.

There is no real witness in this scenario. A recollection may be added only if
it is a real, attributed one with permission; never present a synthetic note as
a memory.

### Earlier proposal: recreation-room light (photograph 19)

This proposal predates the scenario above and is kept as an unverified plan.
The following is a **proposed demonstration**, not a recorded visit or a
person's recollection. It needs a usable scene and explicit choices at each
step; do not substitute a successful result if a build or proposal fails.

1. **Start with the photograph.** Select the recreation-room image and set its
   source and allowed uses deliberately. Select a visible hanging light, build
   a partial scene, and inspect its proposed outline and depth against the
   photo. The photo is evidence; the model's depth and shape are estimates.
   Areas the photo does not show stay unknown. If the result is incomplete or
   unusable, show that limit instead of presenting it as the room.
2. **Try a hypothetical change.** Enter a clearly labeled demonstration-only
   instruction, such as "For this demonstration, move the selected light a
   little left." This is not a historical memory. If a suitable proposal is
   available, compare it with the saved scene and let the owner explicitly
   approve it; otherwise leave the saved scene unchanged. Hosted planning sends
   the text and a photo copy to a provider only after its separate consent.
3. **Compare an alternative.** The demonstrator, using a test contributor,
   submits a clearly labeled synthetic suggestion to place the same selected
   light slightly to the right, with separate allowed uses. The owner reviews it
   and saves an alternative without overwriting the current arrangement. Neither
   suggestion establishes where the fixture was or when it moved; leave time
   unknown. The test contributor is not a witness.
4. **Visit a saved view.** Where the source and contribution allow sharing,
   choose the saved arrangement and, if available, the reviewed alternative;
   capture a starting camera and preview what visitors would see. Keep the
   photograph, model estimate and hypothetical suggestions distinct. Explicitly
   issue a local visitor link only after reviewing the preview; the visitor sees
   the chosen saved snapshot.

The source does not provide a visitor's memory, a personal recording, or proof
that a particular fixture survived the fire. A real contribution and its
permission, a usable reconstructed scene, and visual review of the resulting
visitor view are still needed for a complete demonstration with real memories.
The [Commons item record](https://commons.wikimedia.org/wiki/File:INTERIOR_VIEW_OF_RECREATION_ROOM_OF_MAIN_LODGE_LOOKING_EAST_-_Grand_Canyon_Lodge%2C_Main_Lodge%2C_North_Rim%2C_Grand_Canyon%2C_Coconino_County%2C_AZ_HABS_ARIZ%2C3-GRACAN%2C14A-19.tif)
states a U.S. public-domain basis for this photograph; the HABS collection tag
alone does not establish rights for every item or jurisdiction.

## Synthetic relation fixture

This technical diagram tests whether a new sentence changes a proposed visual
relation. It is not a photograph, a person's memory, or evidence of product
demand. The counter's marked front is a drawing convention.

Generate an SVG with Python 3 and no packages:

```sh
python3 app/demo/generate_room.py --output /tmp/rehere-room.svg
```

The command refuses to overwrite an existing file and checks its geometry
against [expectations.json](expectations.json). Render the SVG at exactly
1024 by 768 pixels before uploading a PNG to the app. Confirm both dimensions
and that the full window, counter, door and synthetic notice remain visible;
a square preview can crop the door. On macOS, `sips` can render it:

```sh
sips -s format png /tmp/rehere-room.svg --out /tmp/rehere-room.png
sips -g pixelWidth -g pixelHeight /tmp/rehere-room.png
```

Freeze the expectations and image hashes before inference. Use the saved
counter box `[392,480,632,650]`. Test window and door statements against the
same original saved position, with separate proposal IDs. Each must identify
its named region; the derived directions should differ. Missing landmarks or
ambiguous front statements should ask a useful question and leave the saved
state unchanged. Inspect the actual direction guide, explicitly approve a
valid proposal, reopen it, then restore the original position as a new version.
Check original checksums throughout. A model failure or an unusable depth/mask
must remain a failed result rather than a substituted successful fixture.

The visible labels simplify landmark recognition, and inferred depth on a
drawing can differ from photographs. These cases do not establish reliability,
emotional value, historical accuracy, or superiority over a photo album.
Live model calls require the app's explicit enablement, permissions, consent
and a separately checked bounded budget; this generator sends nothing.

## Two-object fixture

[two-object-cases.json](two-object-cases.json) holds two constructed synthetic
room diagrams, each with a chair (`object-1`) and a counter (`object-2`), and
eight frozen planner cases. They are drawings, not held-out real photographs,
personal stories or memories. The expected answers check specific planner and
app behavior on these inputs: facing a visible window, asking a question for
the wrong object, an unspecified side or an absent landmark, and an explicit
translation of the selected object. They are not a measure of general accuracy,
and no benchmark result is recorded here.

Generate the PNGs with the reconstruction environment's Pillow; no model is
called:

```sh
app/spatial/.venv/bin/python app/demo/generate_two_objects.py
```

Files go to `app/demo/generated/two-objects/`, which Git ignores, or to
`--output-dir`; existing files are never overwritten. Each image is checked
against its frozen SHA-256. Use the Pillow version pinned in
[the worker requirements](../spatial/requirements.txt); any hash mismatch fails,
and the frozen data is never updated to fit. Use the listed boxes when building a
two-object scene, and judge a facing answer by whether its point lies in the
case's `windowBox`.

Running these cases against a hosted model is a separate, deliberate action:
it needs the app's explicit live enablement, permissions, consent and a
checked budget. This folder includes no automated paid runner.

## Contributor-photo workflow fixture

Generate a separate reference with the same backdrop and chair as room A,
but with the counter drawing 80 pixels left:

```sh
app/spatial/.venv/bin/python app/demo/generate_contribution_photo.py
```

The command uses the pinned Pillow environment, refuses existing output and
checks the baseline against room A's frozen hash. It writes `baseline.png`,
`counter-left.png` and their hashes and diagram coordinates in `fixture.json`
under `app/demo/generated/contributor-photo/`, or `--output-dir`. The original A/B
planner inputs and expected answers stay unchanged. No inference runs.

Use the baseline's existing chair and counter boxes to prepare a two-object
scene. A separate synthetic contributor can submit the leftward reference
with explicit writing, attribution and independent photo uses. The owner
reviews it, chooses the counter, previews a qualitative leftward position and
saves an alternative while the current arrangement stays unchanged. Scene
units are the owner's judgment, never a conversion from the 80-pixel shift.
Time stays unknown unless separately asserted.

Preview a visitor snapshot containing the baseline and alternative, explicitly
including the contributor inspection photo. It should appear only for the
related alternative, with the contributor's claim and owner's interpretation
distinguished from source-derived geometry. Withdraw the bundle and check that
dependent alternatives and snapshots stop, while an independent baseline
snapshot stays usable. Check original hashes before and after the workflow.

This is a constructed diagram workflow, not evidence of automatic photograph
alignment, calibrated movement, historical accuracy or consumer value. The
older room B swaps background landmarks without moving the counter; it cannot
establish a counter-position correction and remains a separate discrepancy
control.

### Static album comparison

To compare the same inputs with an ordinary photo album, build one static page
from an existing contributor-photo fixture folder. Python 3 and its standard
library are sufficient:

```sh
python3 app/demo/generate_album_comparison.py --input-dir app/demo/generated/contributor-photo --output-dir /tmp/rehere-album
```

The command refuses an existing output folder. It accepts the inputs only when
`fixture.json` matches its frozen hash, each PNG matches its listed hash and
size, and the baseline matches room A. It creates a private folder with exact
copies of both PNGs and `album.html`, then reads them back to confirm the bytes.

The page shows both full images without cropping, embedded so it needs no
other file, script or network. They sit side by side on a wide screen and stack
on a narrow one. Each card carries its statement, attribution and unknown time:
the synthetic proposed-turn input "Turn the photographed side of this counter
toward the window." and the exact fictional contribution from the synthetic
account **Synthetic reference contributor**. It also states the attribution,
unknown time, unknowns and source hashes. It shows no model answer, proposal
outcome or measured movement, and it supports no historical or preference claim.

## Archival counter example

Fetch a pinned official display JPEG of Walker Evans's **General store
interior. Moundville, Alabama**, attributed to 1936 by the Library of Congress
[Free to Use and Reuse collection](https://www.loc.gov/free-to-use/advertising-food/).
This is an archival photograph, not a synthetic diagram or a supplied personal
memory. Python 3 and its standard library are sufficient:

```sh
python3 app/demo/fetch_archival_counter.py --output-dir /tmp/rehere-archival-counter
```

The command downloads only the fixed official image, checks its exact byte
count and SHA-256, refuses existing output, and writes `source.jpg` and
`fixture.json`. It does not sign in, upload, infer, grant uses or issue a link.
The default output is `app/demo/generated/archival-counter/`, ignored by Git.

The 1024 by 820 image is a display derivative, not the preservation master.
Keep its provider, public source link and catalog-attributed year with it.
Do not turn that year or the calendar in the image into an exact capture day,
or claim that the shop is now lost. The source provides no personal recording,
recollection or same-place second viewpoint.

For a bounded single-object example, select the visible left-edge wooden
counter portion and leg with the manually chosen box `[12,440,240,805]`.
Review the actual mask and depth; a structural `ready` status does not prove
that the right object was selected. Keep failures as failures rather than
substituting a different result. This box is an example on this exact image,
not an automatic detector or evidence for a different-sized mirror.

A manually chosen hypothetical move can demonstrate preview, save and
**Compare with the photograph** from the same viewpoint. Preserve the original
and derived hashes and leave newly uncovered areas empty. Label it as a
hypothesis, not a recovered historical arrangement or a person's testimony.
This example does not reopen or repair earlier flour-region or photo-pair
failures. It supplies no hosted-model accuracy or consumer-value result.
