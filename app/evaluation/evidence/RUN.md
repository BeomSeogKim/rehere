# Live run during the event

One short live run of the app's three hosted-model features, made during the
event on 2026-11-04. It is a single run per feature, not an evaluation. It
shows that each feature completed through the app's real routes on public
photographs. It does not measure how good the outcome is, and nothing in it
is historical evidence.

## What was run

- Code: commit `6061ec65`, unchanged, in a fresh instance with its own empty
  data folder and its own new spending ledgers. Nothing was mocked, replayed or
  substituted. One feature was turned on per step, and each ledger capped its
  feature: SAM 3.1 at 2 requests and USD 0.01, the scene proposal at 1 request
  and USD 0.10, the evidence check at 1 request and USD 0.10.
- Photographs: Historic American Buildings Survey frames HABS AZ-135-A-26
  (SHA-256 `65a8124abc58b8c65f526b6aeff4b07c782cd8b12de1139e9688ec7a11af4129`)
  and HABS AZ-135-A-16
  (SHA-256 `3709133053b8114373882c9bd6b5bcc58e8bf92900a57d7e1170070cc6e1a573`),
  Richard Frear, July 1982, Library of Congress. U.S. Government work. No
  known restrictions on images made by the U.S. Government.
- Text: two short owner hypotheses written for the demonstration, and fictional
  words from a synthetic test contributor. None is a recollection or a witness
  account.
- Driving: a script holding the owner's session called the app's HTTP routes.
  It checked the photo hashes, the current permissions and empty ledgers, and
  saved a record of each attempt before the request that could send anything.
  Screenshots of the owner pages were taken afterwards, with the hosted models
  turned off. Every request below was sent once. None was retried.
- Times are the host clock: 11:07:29 to 11:09:20 UTC (20:07 to 20:09 KST).

## Outcomes

| Step | Model | Response ID | Latency | Outcome |
|---|---|---|---|---|
| Outline "rocking chair" in A-26 | `sam-3.1` | `resp_6aeb11f2a7ca0f8983f84ddd` | 2,094 ms | One instance; selected (IoU 0.9429 with the owner's box) |
| Outline "wicker chest" in A-26 | `sam-3.1` | `resp_6aeb11f4f6e854b81c0a4827` | 1,574 ms | One instance; selected (IoU 0.9546) |
| Scene proposal on a saved alternative | `muse-spark-1.3` | `resp_6aeb1241f83ad239ef2d4477` | 7,518 ms | Turn the wicker chest by -5 degrees; not applied |
| Evidence check of a note against A-16 and A-26 | `muse-spark-1.3` | `resp_6aeb1260c7c9d6b98a114d60` | 6,579 ms | Two parts supported in A-16, one not visible; not kept or dismissed |

**Outlines.** Each object name was sent as one concept prompt with the photo.
The app keeps a returned outline only when its box overlaps the owner's box
with IoU of at least 0.5 and no runner-up comes within 0.15. Here each request
returned one instance, and both were kept. The model's confidence (0.68 and
0.92) was recorded and not used to choose. The saved scene records both
outlines as live SAM 3.1 results with these response IDs. The depth is a local
Depth Anything V2 Small estimate at a pinned revision. The objects cover 4.17%
and 8.81% of the photo, with 3,970 and 8,895 triangles and no overlap.

Two requests with the same request digests had been recorded earlier for the
demo. The chest outline came back byte-identical. The chair outline differed
slightly: confidence 0.680 instead of 0.675, the same box, and 3,970 triangles
instead of 3,972. So the same request can return a slightly different outline.
This run claims no improvement over the local SAM 2.1 outlines.

**Scene proposal.** The scene had a saved alternative in which the synthetic
contributor's chair sits 0.12 units closer to the chest. The owner hypothesis
was "I think the wicker chest was turned five degrees to the left". The model
proposed turning the chest by -0.0873 radians (-5 degrees), with no move. The
chair's position and the rule "rocking chair stays left of the wicker chest"
were kept. Its reason: "The memory describes the wicker chest rotated five
degrees left." The proposal is waiting for the owner; nothing was saved from
it.

**Evidence check.** Note: "The dining room had large windows looking out over
the canyon." The model split it into three parts:

| Part | Verdict | Photo | Observation |
|---|---|---|---|
| "The dining room" | supports | A-16 | Photo shows a large set dining hall with many tables. |
| "had large windows" | supports | A-16 | Three tall wide windows stand along the far end wall. |
| "looking out over the canyon." | not_visible | none | The windows are overexposed white with no canyon detail visible. |

What these photos cannot settle, in the model's words: "The photos cannot
settle what view, if any, the windows overlook." The app checked each part
against the note and each region against the photo before showing it. "Not
visible" never means that a part is false. The result is waiting for the
owner's decision.

## Cost

USD 0.0179 by the app's own local estimate, not a provider bill:

- outlines: 2 x 0.0025 (one image each);
- scene proposal: 0.00637 (2,186 input and 857 output tokens);
- evidence check: 0.00650 (2,725 input and 729 output tokens).

Every ledger entry settled, and no reservation is open.

## Unknowns and limits

- The bill is unknown. The SAM 3.1 response reports one processed image but no
  amount. The other estimates come from published token prices. Whether the
  separate token-count request before each Muse Spark request is billed was
  not measured.
- This is one run per feature, so it says nothing about how often these
  outcomes repeat. The chair outline above already varied slightly between two
  identical requests.
- The proposal and the evidence result are model output waiting for an owner
  decision. Neither establishes what the room looked like or how the furniture
  stood.
- Depth ran on this computer's GPU (MPS) with the pinned packages. Another
  device can give slightly different depth.
- The local Python packages came from another environment on the same computer
  that pins the same requirement versions.
