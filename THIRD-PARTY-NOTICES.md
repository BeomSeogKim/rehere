# Third-party notices

Rehere's source code and documentation are licensed under the Apache License,
Version 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). That license covers only
the files in this repository. It does not relicense anything listed below, and
it does not grant rights in photographs, recordings or memories.

## Code served to the browser

The app serves these pinned npm packages (installed by `npm ci`, not committed)
and copies the Three.js files, with their notice, into a static visitor export.
Both are MIT-licensed; their notices follow.

### three 0.187.0

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### three-mesh-bvh 0.9.17

Used by the owner editor only; it is not part of a static visitor export.

```text
MIT License

Copyright (c) 2018 Garrett Johnson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Python packages for local reconstruction

These are installed by the user from `app/spatial/requirements.txt` and are not
redistributed here. Licenses are as declared on PyPI on 2026-11-04.

| Package | Declared license |
| --- | --- |
| numpy 2.5.4 | BSD-3-Clause, with bundled components under 0BSD, MIT, Zlib and CC0-1.0 |
| pillow 13.0.0 | MIT-CMU |
| torch 2.15.0 | BSD-3-Clause, with bundled components under Apache-2.0, BSD-2-Clause, BSL-1.0, ISC, MIT and Zlib |
| torchvision 0.29.2 | BSD |
| transformers 5.22.1 | Apache-2.0 |

The optional full-object worker also runs third-party TripoSR source that its
own pins verify; that source and its dependencies keep their own licenses.

## Model weights

No model weights are bundled. A user downloads them from Hugging Face into a
local cache, and each model stays under its own license, which governs its use
and any output the user redistributes. Rehere does not inherit or sublicense
these terms. Licenses are the model tags on the pinned revisions, checked on
2026-11-04.

| Model | Pinned revision | License | Used for |
| --- | --- | --- | --- |
| `depth-anything/Depth-Anything-V2-Small-hf` | `5426e4f0f36572d16453bbda7a8389317b1bef99` | Apache-2.0 | relative depth |
| `facebook/sam2.1-hiera-tiny` | `de431c4043854a71d8101e17995dfe596bf101a5` | Apache-2.0 | object masks |
| `stabilityai/TripoSR` | `5b521936b01fbe1890f6f9baed0254ab6351c04a` | MIT | optional full-object estimate |
| `facebook/dino-vitb16` | `f205d5d8e640a89a2b8ef0369670dfc37cc07fc2` | Apache-2.0 | image features for TripoSR |

Larger Depth Anything V2 models use a different, non-commercial license, so
replacing the pinned Small model requires a new license check.

## Hosted model API

The optional planner calls Meta's Muse Spark, and the optional caption drafts
call Meta's Muse Voice Transcribe, both through Meta's API under Meta's own
terms. Both are off by default. Neither model's weights are bundled or
distributed with Rehere.

## Photographs, recordings and memories

Source photographs, recordings and written memories that a person adds, and
any demonstration imagery, keep their own rights and permissions, recorded per
source in the app. They are not covered by the Apache License. The demonstration
photographs of Grand Canyon Lodge are Library of Congress HABS items, described
in [the demonstration guide](app/demo/README.md); they are not committed here.
