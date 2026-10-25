# Contributing to Graft

Thanks for helping! Graft is early-stage, so small, focused contributions are very welcome.

## Getting started

Requires Node.js 20.19+ and npm 10+.

```bash
git clone https://github.com/himanshu748/graft-webmcp.git
cd graft-webmcp
npm install
npm run dev
```

## Before opening a pull request

```bash
npm test
npm run build
npm run check:owner-adapter   # if you changed the runtime or exported adapter
```

- Open an issue first for larger changes so we can agree on direction.
- Keep PRs small and focused; add or update tests for behavior changes.
- Use clear commit messages (e.g. `fix: ...`, `feat: ...`, `docs: ...`).
- Safety checks (SSRF protection, robots.txt, sensitive-domain refusal) must not be weakened.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/himanshu748/graft-webmcp/issues/new/choose). For security problems, see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
