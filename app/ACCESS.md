# Local workspace access

One server instance has one private workspace owner. Credentials establish
possession of that authority, not a verified name or relationship. Scoped
contributors have separate credentials; enrolling one does not give them the
owner's source files or editing APIs. Enrolled contributors can submit their
own [written recollections](COLLABORATION.md) for review. Visitor sharing is
a separate unfinished feature.

## First setup

From the repository root:

```sh
mkdir -m 700 -p app/data
node app/access-cli.mjs init --credentials-file app/data/owner-card.json \
  --name "Workspace owner"
cd app
npm start
```

The CLI writes a private card before creating the owner and prints its path,
never its keys. It refuses existing files, served directories and source-tree
destinations that are not accepted runtime storage. The card is plaintext;
keep it private and retain a separate secure copy. Anyone holding its access
or recovery key can take over the workspace. The owner can read all existing
local memories after setup; their original files are not rewritten.

If the card was written but setup could not finish, repeat the same command
with `--resume`. A replay confirms that setup request without replacing later
credentials. An old card does not become valid again after recovery.

Open the app, choose **Use a saved access card**, review the card locally and
explicitly sign in. Selecting a file sends nothing. Use the same host and port
as the card; `localhost` and `127.0.0.1` have separate browser cookies. When
changing the port, use the same `PORT` value for setup and the server.

## Sessions and recovery

The server accepts sessions through a port-specific HttpOnly, SameSite cookie.
Every private API request checks authority before looking up content or
processing ranges. Anonymous users and contributors cannot enumerate owner
drafts, read originals or derivatives, or apply edits. Private responses use
`Cache-Control: no-store`. No credential belongs in a URL or browser storage.

Sessions expire after twelve hours or thirty minutes without authenticated
request activity. Logging out ends that session. Replacing keys ends all of
that principal's sessions, preserves their identity and grants, and requires a
new sign-in. A failed replacement does not rotate stored credentials.

Before joining or replacing keys, prepare and retain the new card, then
acknowledge that it was saved. A download request cannot prove retention.
Keep the same prepared keys through an uncertain response. If replacement
cannot be confirmed, explicitly sign in using the retained new access key;
only successful authentication confirms it works. A refused login alone does
not prove which keys are current. Keep the previous card until reconciliation.
Losing both usable access and recovery keys has no self-service recovery.

An enrollment card includes its original request ID and invitation code so it
can repeat that exact join after reload. Redemption consumes an invitation
once; a matching replay returns the same identity without creating another.
Closing an invitation does not erase an enrolled person's identity or recovery
authority. Old replays never restore superseded credentials.

## Scope and operation

Run one server process per data directory. Bootstrap uses create-only atomic
publication, so competing or delayed initializers cannot overwrite established
authority. Normal updates serialize within one process and replace the access
state atomically. No multi-server coordination or power-loss durability is
claimed.

The server remains loopback-only over HTTP. This is not encrypted remote
enrollment or hosted authentication readiness. Failed credential attempts share
a bounded per-address limit; on loopback all local clients share that bucket.
Logout and recovery do not claim to cancel model requests already admitted.
Deleting `app/data/` also removes workspace authority and any card stored there.

The implementation follows a narrow application-specific contract informed by
OWASP's [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
and [authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
guidance. It does not claim an external security audit.
