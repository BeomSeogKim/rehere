# Synthetic relation fixture

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
