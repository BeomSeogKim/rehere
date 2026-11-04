# Frozen static visit

`export-static-visit.mjs` copies one saved visitor snapshot into a folder of
plain files: the visitor page, its exact modules, the pinned Three.js files and
the snapshot's own images, scene data and audio. Any static file server can
show the folder. It needs no Node.js, Python, models, account or network
service at view time.

## What this copy is not

The page opens with an **Offline snapshot** notice, and the notice is part of
the contract. The folder is a copy made on the export date. It is not connected
to the app, so later revocation of the link, withdrawal of a memory or a change
to a source's permitted uses does **not** change or stop it. In the live app
those actions stop the views that depend on them. To take a published copy
down, remove the folder from the file server and any cache that holds it.

## Export

Run the app with the visitor listener, issue a visit link for a snapshot that
holds only public or synthetic material, and keep the link's capability (the
`rhv_...` part after `#/visit/`) out of shell history and files. See
[visitor-only ingress](VISITOR-INGRESS.md). Then, from `app/`:

```sh
read -rs REHERE_VISIT_TOKEN && export REHERE_VISIT_TOKEN
node export-static-visit.mjs --origin http://localhost:4318 \
  --out ../demo-site --confirm-public-material
```

`--confirm-public-material` is required: it records that the snapshot was
reviewed and that its sources allow public display. The command prints the
snapshot title, whether it is marked synthetic, and every contributor label
that visitors will see. Review those and the folder before publishing.

Preview locally with any file server, for example
`python3 -m http.server 8080 --bind 127.0.0.1 --directory ../demo-site`.
The page uses relative paths, so it also works from a sub-path.

## What is written

Only these are written, and the export stops with an error otherwise:

- `index.html`, `style.css` and the visitor modules the live visitor listener
  serves (checked against `server.mjs` by a test), with root-absolute vendor
  imports made relative.
- `vendor/`: the pinned Three.js files used for viewing, with their MIT notice.
- `data/manifest.json`, and per view only the exact asset names the visitor
  listener admits, the contributor photos the manifest lists, and the story and
  recording audio the manifest lists.
- `EXPORT.json`: the export date, snapshot ID, and a SHA-256 for every file.

The capability is sent only as an `Authorization` header. The export stops if
any file contains it, the source origin, a local path, an email address, an
API route in the page or data, or a photo metadata block, or if a file or the
total exceeds the size limits. Owner, contributor and editing routes are never
requested, and the exported page cannot call them.

The unchanged visitor modules still contain their live-visit code paths; the
static entry never uses them because it supplies its own read-only source.

## Limits

- A snapshot's rights are the owner's to confirm. The export does not decide
  whether a photograph or memory may be shown publicly.
- Browsers may require a secure context or correct MIME types from the file
  server for audio and modules; common static hosts provide both.
- Use `npm test` to run the exporter tests, which use a fake visitor server and
  synthetic files only.
