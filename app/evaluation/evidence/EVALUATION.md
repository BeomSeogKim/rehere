# Evidence-review evaluation

How often does the owner evidence review, which asks a hosted model to check
one written note against supplied photographs, agree with expected verdicts
written beforehand for 40 notes about six public photographs?

**Read this first.** The expected verdicts were written by the development team
(AI-assisted). They are not independent annotators' labels, and they describe
what we expect a careful viewer to see in these frames, never historical truth.
A separate AI model review (another development-team review, not independent
validation) checked the labels against the pinned frames. Nothing here is a
benchmark of the model in general.

## What was run

- Photographs: six public Historic American Buildings Survey frames of the
  Grand Canyon Lodge (HABS AZ-135-A-15, -16, -18, -19, -20, -26), pinned by
  SHA-256 in [claims.json](claims.json), with credits and rights notes.
- Claims: 40 short first-person notes ("I think a padded bench stood in front
  of the fireplace"), each with an expected verdict and a one-line rationale:
  16 supports, 10 conflicts, 14 not_visible. Dataset SHA-256
  `2af0c93c3fce81ea235d09464fdd9d05a2121455f54d5b082822ce1ac13543c6`.
  34 claims have one photo; 6 have two.
- Path: every check goes through the real app route
  (`POST /api/drafts/<id>/evidence-reviews`) in an in-process server with its
  own data folder, one saved memory per claim, consent given, no retries.
- Model: `muse-spark-1.3` through the Meta Responses API, 3 runs per claim at
  reasoning effort `low` and at `medium`: 240 checks, all sent, all with a
  response id. Raw results: [results/full-run.json](results/full-run.json);
  budget ledger: [results/full-run-ledger.json](results/full-run-ledger.json).
- Photo preparation ran this repository's scripts with a Python interpreter and
  packages (Pillow 13.0.0) from another local environment. That step re-encodes
  each photograph before it is sent, so a different Pillow version could change
  the image bytes the model sees.

**Captions are not sent, by design.** The model receives the note and the
photographs, not their captions. Many notes name a room that only the caption
gives ("the sun room"), so the room-name part is expected to come back
`not_visible`. That is the app working as designed, and it lowers strict
agreement.

## Scoring rules

An answer is a list of parts. The claim-level verdict is `conflicts` if any
part conflicts, `supports` if every part supports, `not_visible` if every part is
not_visible, and `mixed` otherwise. A check that produced no valid answer is a
miss.

- **Primary, strict (fixed before any live call):** the claim-level verdict equals
  the expected verdict. Conflicts take precedence as defined above; mixed and
  invalid answers are misses.
- **Secondary, part-aware (added after an 8-check pilot, before the full run):** a
  sent check agrees when at least one part carries the expected verdict and,
  unless the expected verdict is conflicts, no part conflicts. Supports or
  not_visible parts beside the expected one are allowed, because the app checks
  each part of a note separately. It still counts a not_visible claim as
  agreement when the model wrongly supports the key fact and marks another part
  not_visible; the strict rule catches that.
- **Mixed rate:** the share of answers whose parts disagree.

No label or scoring rule changed after any full-run answer was seen. The
part-aware rule was added after the 8-check pilot's answers, before the full
run. One label (c06) was changed from conflicts to not_visible before the full
run, from the first label check, because one dark frame cannot settle whether a
fire burned at another time; c06 was not in the pilot. The pilot ran on an
earlier dataset version (SHA-256
`5c6cffe8fca4d636b731640de1c0515c7089fe1a5826139a333a8b8419f39c8d`) that differs
only in c06's label, which the pilot did not use; results/pilot.json was scored
with the strict rule only.

## Results

All 40 claims, 120 checks per effort (3 runs each). Shares are over the checks
shown; per-class n is in the second table.

| Measure | low | medium |
|---|---|---|
| Strict agreement (primary) | 0.525 (63/120) | 0.550 (66/120) |
| Part-aware agreement (secondary) | 0.783 (94/120) | 0.875 (105/120) |
| Mixed rate | 0.258 (31/120) | 0.325 (39/120) |
| Invalid answers (counted as misses) | 14/120 | 2/120 |
| Claims where the majority of 3 runs matches | 0.550 (22/40) | 0.575 (23/40) |
| Claims where all 3 runs agree | 0.550 (22/40) | 0.700 (28/40) |
| Pairwise consistency between runs | 0.683 | 0.800 |

Strict agreement by expected class:

| Expected | n per effort | low | medium |
|---|---|---|---|
| supports | 48 | 0.542 | 0.563 |
| conflicts | 30 | 0.800 | 0.867 |
| not_visible | 42 | 0.310 | 0.310 |

The 34 claims without a flag below (102 checks per effort; the only subset,
announced before the run):

| Measure | low | medium |
|---|---|---|
| Strict agreement | 0.539 | 0.569 |
| Part-aware agreement | 0.814 | 0.912 |
| Mixed rate | 0.275 | 0.343 |
| Invalid answers | 12/102 | 2/102 |

Reading: the model agrees most on notes with a visible contradiction (conflicts)
and least on notes the photographs cannot settle (not_visible). Of the 42
not_visible checks per effort, 22 (low) and 23 (medium) were mixed answers, a
supported visible part plus a not_visible part; 2 and 4 read absence as a
conflict, 3 and 1 supported the claim, and 2 and 1 gave no valid answer. Medium
effort was more consistent between runs and made fewer invalid answers, at
about 50% more cost and 60% more model-call time. Neither figure
shows the model is right about the past; they show how often it agrees with
our expectations.

### Source choice (small sample)

`sourceAccuracy` is conditional source-choice agreement, not retrieval accuracy.
A check counts only if the claim has two photos and an expected photo, and the
answer was correct on supports or conflicts. Over all 40 claims only s14, s15 and s16 can contribute. s16 (expected photo
listed second) was never answered supports, so all 6 rows per effort come from
s14 and s15, and all cite the expected photo (6/6 low, 6/6 medium). In both
contributing claims the expected photo is listed first, so this sample cannot
separate source choice from position. On the 34 claims (s14 is flagged) the
figure rests on s15 alone: 3/3 per effort. s14's label is flagged for the
colour word "white", but its source choice was correct in all six runs.

## Label flags: A separate AI model review (another development-team review, not independent validation)

A separate AI model review (another development-team review, not independent
validation) checked every label against the frames in two passes: the first
before the full run (it led to the c06 relabel and flagged the six claims
below), the second while the run was in progress. Neither pass changed a
label after answers existed.

| Claims | Result | Reason |
|---|---|---|
| s04, s14 | REVISE, kept as stored | "White" tablecloths cannot be seen in a black-and-white frame; the dataset treats colour as not_visible elsewhere. |
| s08, s13, n12, n13 | Ambiguous, then accepted | s08 "in front of" versus left of the fireplace; s13 drawer count; n12 and n13 are absence claims where a second photo shows the object. |
| c06 | Relabelled before the full run | One dark frame cannot settle a transient fire. |

Flagged labels were not changed or dropped after answers existed. The 34-claim
subset leaves out s04, s14, s08, s13, n12, n13 for reporting only; there is no
other subset.

## Failure examples

The regions the model pointed at for two wrong answers, as fractions of the
photograph (`[left, top, right, bottom]`, from results/full-run.json; the
repository holds no images, so render them with `crops.mjs` from the pinned
public photographs):

- **s08** (padded bench in front of the fireplace, expected supports; HABS
  AZ-135-A-18, medium effort, run 1): the answer supports the bench
  (`[0.36, 0.792, 0.484, 0.874]`, "a three-cushion padded bench stands on the
  open floor") but conflicts on "in front", citing an empty floor at the
  opening (`[0.56, 0.696, 0.77, 0.84]`). The bench stands beside it, which is why
  the label is flagged.
- **n13** (rows of lecture chairs in the lobby, expected not_visible; photos
  A-15 and A-19, medium effort, run 1): the answer supports from the second
  photograph, a different room (`[0.23, 0.65, 0.91, 0.89]`, "many chairs in
  neat rows"). This is the two-photo trap the label check named.

Of the 240 checks, 16 gave no valid answer (the model's crop region failed the
app's check, so no result is offered; the app log records the reason "crop"
for all 16); they stay in every denominator.

## Cost

240 checks cost USD 1.9008 by the app's own local usage estimate from published prices (low 0.762,
medium 1.139), not a provider bill; the ledger holds 240 settled entries and
no open reservation, and they sum to the same estimate. The model call took a
median 18 s at low effort and 29 s at medium (33 s and 45 s through the app). An earlier 8-check
pilot's estimate was USD 0.0737 (results/pilot.json). Whether the separate token-count
request is billed was not measured here.

## Limits

- Expected verdicts are the team's, written with AI assistance; no independent
  annotators and no inter-annotator agreement.
- Forty notes about six photographs of one place, one model, three runs.
- Captions withheld by design; colour and wording ambiguities are in the labels.
- Strict agreement punishes correct per-part answers; the part-aware rule was
  added after seeing a small pilot, so both are shown.
- Results describe agreement with these expectations, not the truth about the
  lodge, and not other photographs or models.
