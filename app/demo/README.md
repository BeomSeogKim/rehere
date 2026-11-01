# Demonstration fixtures

## Synthetic relation fixture

This technical diagram tests whether a new sentence changes a proposed visual
relation. It is not a photograph, a person's memory, or evidence of product
demand. The counter's marked front is a drawing convention.

Generate an SVG with Python 3 and no packages:

```sh
python3 generate_room.py --output /tmp/rehere-room.svg
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
../spatial/.venv/bin/python generate_two_objects.py
```

Files go to `generated/two-objects/`, which Git ignores, or to
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
../spatial/.venv/bin/python generate_contribution_photo.py
```

The command uses the pinned Pillow environment, refuses existing output and
checks the baseline against room A's frozen hash. It writes `baseline.png`,
`counter-left.png` and their hashes and diagram coordinates in `fixture.json`
under `generated/contributor-photo/`, or `--output-dir`. The original A/B
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
python3 generate_album_comparison.py --input-dir generated/contributor-photo --output-dir /tmp/rehere-album
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
python3 fetch_archival_counter.py --output-dir /tmp/rehere-archival-counter
```

The command downloads only the fixed official image, checks its exact byte
count and SHA-256, refuses existing output, and writes `source.jpg` and
`fixture.json`. It does not sign in, upload, infer, grant uses or issue a link.
The default output is `generated/archival-counter/`, ignored by Git.

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
