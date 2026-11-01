# Visitor-only ingress

An optional second listener serves saved visitor snapshots while account,
contributor and editing routes stay on the private loopback listener. Both
listeners share the same stores in one process, so revocation and source-use
changes govern new visitor requests without copying the workspace.

This prepares a read-only endpoint for an external HTTPS proxy. It does not
publish a place, configure a proxy, provide certificates or establish that an
address is reachable. The default server still has one loopback listener.

## Local verification

Prepare the workspace owner using [the access guide](ACCESS.md). From `app/`,
start both listeners with an explicit visitor origin and a different port:

```sh
REHERE_VISITOR_ORIGIN=http://localhost:4318 REHERE_VISITOR_PORT=4318 npm start
```

The owner signs in at `http://127.0.0.1:4317/`. The visitor entry is at
`http://localhost:4318/`; without a visit fragment it asks for a visit link and
makes no session or content request. The owner must still select permitted
content, preview it and explicitly issue a link. The issued link uses the
configured visitor origin, with its capability in the fragment. Configuration
alone does not make an existing local link remote or publish a snapshot.

Open the issued link in a separate browser. Check the saved views and any
explicitly included media, then revoke the link from the owner screen. New
visitor requests must fail and an open visit must stop after rechecking access.
An independent snapshot should remain available when its own rights still
allow it. See [saved visitor views](SHARING.md) for expiry, withdrawal and the
limits of recalling delivered bytes.

Both ports bind to `127.0.0.1`. `PORT` can change the private port; the visitor
port must differ. Supplying only one visitor setting or an invalid origin or
port fails startup. Closing the app closes both listeners. Run only one app
process per data directory.

## External proxy boundary

A separately operated HTTPS proxy can forward to the visitor port. Configure
`REHERE_VISITOR_ORIGIN` to its exact canonical HTTPS origin, for example
`https://visit.example.invalid`, and set `REHERE_VISITOR_PORT` separately.
The example is a placeholder, not a hosted product address. Origins have no
credentials, path, trailing slash, query or fragment. HTTP is accepted only
for explicit-port `localhost` or `127.0.0.1` local verification.

Forward **only the visitor port**, preserving the configured origin's Host.
Never forward the private port or rewrite a public request to impersonate its
loopback Host. The app ignores forwarded-host and forwarded-address headers.
TLS termination, public DNS, rate limiting, a process supervisor, backups and
persistent disk are operator responsibilities; this feature supplies none of
them. A hosted deployment and its exposure require a separate operational
review. No general multi-process or power-loss guarantee is provided.

The visitor listener has a small fixed surface:

- GET and HEAD for its standalone entry, stylesheet, visitor modules and pinned
  Three.js files.
- The existing `/api/visit` manifest, allowed assets and selected audio routes,
  each authorized only by its Bearer visit capability.

All other paths and methods are refused before private routing or body parsing.
No visitor request authenticates with an owner cookie or creates a session.
Account, recovery, invitation, upload, contribution, model, edit and share-issue
routes are unavailable on this listener, even with valid private credentials.
No `Set-Cookie` is returned. A restrictive CSP, no-referrer policy and disabled
microphone, camera and location permissions apply. The entry uses no analytics
or browser storage and sends visitor fetches with credentials omitted.

The original and hidden source details have no visitor route. Visible photo
pixels, selected quotations and explicitly included recordings can still be
sensitive: inspect the actual preview and current grants before issuing a link.
The public endpoint serves stored output; it cannot invoke the model, construct
a scene or enable paid processing. Existing offline scene preparation and
optional owner-side model processing retain their own setup and permissions.
