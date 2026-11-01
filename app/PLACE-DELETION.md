# Remove a place from local storage

The workspace owner can remove one saved place from this app's tracked
storage on this computer. This is separate from stopping use of one original,
withdrawing a contribution or revoking a visitor link. Those actions do not
remove the owner's retained originals. See [source uses](SOURCE-USES.md) and
[contribution removal](COLLABORATION.md).

## Review and confirm

Open the saved place and expand **Delete this place from this computer…**
after its original materials. Review the stored-material counts and the
limits before confirming. Opening the review and choosing **Keep this place**
leave the place and unsaved scene preview unchanged.

The scope is the whole saved place, including:

- Its original photographs, writing, recording, attribution and place name.
- Every scene and arrangement, inferred asset, saved proposal, region link,
  recorded story, listening copy and caption history stored for that place.
- The workspace's copies of contributions received for that place, including
  their originals and derived inspection or listening files.
- Saved visitor previews and snapshots, and temporary upload or processing
  copies belonging to that place.

The review includes retained and stopped material, rather than just what is
currently displayed. Receipt counts describe the accepted removal scope,
including work active when requested; they are not live remaining-file counts.
Confirmation discards unsaved scene edits and previews
on that screen. Other saved places and independent compose input stay intact.
The action grants no new use, changes no public-origin restriction and makes
nothing public.

Removing contributors' copies from this workspace is not a withdrawal made on
their behalf or a claim that their originals elsewhere were deleted. Account
credentials and their minimal place-scope identifiers remain separate; a dead
place cannot be opened or joined through its old invitation.

## Access stopped and cleanup complete

Acceptance first stops access to the place. Its originals, scenes, stories,
contributions and visitor links cannot be newly read or changed through the
app. The saved list omits it. A deletion receipt distinguishes:

- **Access stopped:** the request was accepted, but local file cleanup has
  not yet been verified. The pending list offers **Check** and
  **Retry local cleanup**.
- **Complete:** the app verified the absence of its tracked local content and
  temporary copies. The receipt records the completion time.

A cancellation request is not proof that a worker has stopped writing.
Cleanup remains pending while an owned writer is unresolved or a path cannot
be safely removed. Unexpected files, symbolic links and special files are not
followed or removed. A remaining unsafe path or failed file operation must
not be reported as complete.

## Unclear answers and recovery

If confirmation is lost, the request may have been accepted. Keep the same
request for an explicit retry or check its state. A read that still reports
the place present does not prove an earlier in-flight request cannot finish.
Do not create another attempt merely because the response was unclear.
A stale review requires a new explicit review before another confirmation.

Only the opaque request identifier and impact digest are retained in
owner-scoped browser storage for this recovery. They contain no place name,
source text, files or access tokens. If another accepted request already
removed the place, its current deletion state is shown instead.

Check only reads the current state. Cleanup resumes after a process restart
or an explicit same-request retry; it does not continue by itself when a
writer finishes. Permanent content-free barriers reserve the removed place identifier,
consume its upload recovery path and retain used visitor-token verifiers.
An old upload cannot recreate it, and a deleted visitor token cannot be
issued for another place. Unrelated credentials, places and the usage ledger
are not removed or reset. An already admitted provider operation may still
settle its actual usage after cancellation.

## Scope that remains outside this removal

This action does not establish secure erasure or remove backups, operator
copies, logs, operating-system or browser caches, visitor downloads or
recordings, or material already delivered to a model provider. Already
admitted or delivered bytes cannot be recalled. Account records are separate
from place content. No backup-expiry or provider-retention guarantee is made,
and removal does not enable personal-material use that is otherwise gated.

The guarantees coordinate one app process owning its data directory and
process-restart recovery. They do not establish multi-process coordination or
power-loss durability.

## Private API

All routes require the owner session and stay off visitor ingress.

| Endpoint | Purpose |
|---|---|
| `GET /api/drafts/<id>/deletion` | Review current scope or read the accepted deletion state |
| `POST /api/drafts/<id>/delete` | Confirm or reconcile the same request using `requestId`, `impactSha256` and `confirmDeletion: true` |
| `GET /api/place-deletions` | Pending local cleanup receipts, without names or content |

Read routes also support HEAD. Acceptance returns 202 while cleanup remains
pending and 200 when complete. A changed impact, conflicting request identity
or new request for an already removed place returns 409. Once the durable
barrier exists, cleanup failures remain pending rather than being described
as a deletion refusal. The normal deleted-place read returns its generic 404;
the owner can still read the separate deletion state.
