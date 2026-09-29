# The icons and their licences

The SVG files here are drawn by the v1 kit (`worker/src/pages/kit.ts`) and
served in its one stylesheet, `/assets/kit.<hash>.css`, whose header repeats
the notices below. Two of them, Lucide's `sun` and `moon`, are also drawn
inline in the header of every page, as the theme switch's icons (#272). Each file is the package's own, byte for byte: taken
from the npm registry's tarball (integrity checked against the registry),
the SVG extracted and nothing of the package run.

## `lucide/`: Lucide icons

- Package: `lucide-static` 0.400.0, `icons/<name>.svg`
  (`sha512-FO2xYNDYluDTSQm3K06NBnBi0k+RhHNtsgM8JbC5Y1WgKeGP78/ekbAZO06cyqXF9wA5SzjAOXn/6TwcUOFcfA==`)
- Home: https://lucide.dev, https://github.com/lucide-icons/lucide
- Licence: ISC

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## `agents/`: the agents' marks

- Package: `@lobehub/icons-static-svg` 1.95.1, `icons/<name>.svg`
  (`sha512-Hw7EPPgVnC4NZLXBfTNJG6hyQgqECfUPC11VVXodPSr1aebKcFxDZlSpxhWwYNdCc6bhxps/x5TtXoPmfKH2ag==`)
- Home: https://github.com/lobehub/lobe-icons
- Licence: MIT (the package's `license` field; the text below is the
  repository's `LICENSE`, which the tarball does not carry)
- The marks are trademarks of their owners (Anthropic, OpenAI, Anysphere,
  Google, GitHub, xAI, the opencode project, Alibaba Cloud, Moonshot AI,
  Meta). The pool shows them only to name the agent a person connects or
  a worker runs, as the prototype does; the licence above covers the
  drawings, not the marks.

```
MIT License

Copyright (c) 2023 LobeHub

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

## Adding one

Take the file from the same package version's tarball (`npm view
<package>@<version> dist.tarball dist.integrity`, download it, check the
integrity, extract only `package/icons/<name>.svg`), put it in its folder,
and add its name to `LUCIDE` or `AGENT_MARKS` in `kit.ts`. A new version of
a package is a change of this file too.
