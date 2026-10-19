# CHARS

Bun monorepo with a Next.js application and shared packages.

## Structure

- `app/` — Next.js App Router application with TypeScript, Tailwind CSS, and ESLint.
- `packages/chars-algorithm/` — empty package reserved for the algorithm.
- `packages/*/` — additional workspace packages (each needs a `package.json`).

## Development

Use Bun 1.3.14. From the repository root:

```sh
bun install
bun run dev
```

Open http://localhost:3000. Edit `app/app/page.tsx` to change the home page.

```sh
bun run build
bun run start
bun run lint
bun run typecheck
```

Dependencies and the shared `bun.lock` are managed from the repository root.
When a package is ready to be consumed, add it to the consuming workspace's
dependencies with the `workspace:*` version range.
