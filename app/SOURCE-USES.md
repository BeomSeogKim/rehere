# Current source uses

An owner can narrow the permitted uses of an imported photo, written memory or
recording. Open its source details, expand **Uses**, uncheck a currently allowed
use and save. Previously denied uses cannot be enabled. Contributor statements
remain controlled by their own provider through contribution withdrawal.

Place construction, model processing and visitor sharing are separate grants.
New local reconstruction and hosted planning require both place and model use.
Turning off model use does not remove a completed scene or prohibit separately
permitted manual edits and visitor sharing. A previously ready proposal can be
explicitly approved without making another model request, provided its scene,
version and other dependencies remain valid.

## Stop using material

**Stop using material** requires a second confirmation and shows the current
local scene, snapshot and processing counts. Stopping use is irreversible in
this interface. It removes the material from new archive responses and blocks
its dependent uses; it does not delete the retained original. A stopped photo
blocks every scene version and alternative derived from it. Restoring an older
transform cannot restore permission. A stopped recording is removed from the
owner's current playback view.

Turning off sharing suspends dependent visitor snapshots while still allowing
private uses covered by the remaining grants. New manifests and assets check
current policy, including HEAD and range requests. Open visitor screens use the
same periodic access check as link revocation. Previously delivered bytes cannot
be recalled. See [sharing](SHARING.md).

## Saved restrictions and work in progress

The restriction is saved before cancellation is requested. The response separates
saved policy from whether stopping active work was requested or could not be
confirmed. Data already sent to an external provider cannot be recalled, and
cancellation does not prove that the provider stopped processing or charging.
The server checks current model permission at each new outbound operation and
before publishing a result. A late result cannot restore a denied use.

If confirmation is lost, retry the unchanged prepared request to reconcile it.
A stale revision requires refreshing the current policy rather than overwriting
it. Old receipts return current restrictions and never restore earlier grants.

## Storage and boundaries

Restrictions live in a separate, atomically replaced `policy.json` beside the
immutable draft and original media. Effective permissions are the intersection
of original grants and current restrictions. Missing legacy grants never become
processing or sharing permission. Legacy originals remain owner-only archives;
per-source controls need the source identifiers introduced in newer drafts.
Unreadable or invalid policy files fail closed instead of granting default use.

Stopped source projections retain a limited provider/checksum marker without
the original content, filenames, references or free-form dates. Original bytes
and metadata stay on disk. One server process owns the data directory; this is
not a multi-server transaction or power-loss guarantee, secure deletion service,
identity verification or proof of copyright ownership.
