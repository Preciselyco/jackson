# CLAUDE.md

## What this repo is

Precisely's fork of [ory/polis](https://github.com/ory/polis) (formerly
`boxyhq/jackson`) — Enterprise SSO (SAML/OIDC) and Directory Sync (SCIM 2.0).
Origin is `git@github.com:Preciselyco/jackson.git`; upstream is `ory/polis`.

**Read `PRECISELY.md`** for the full description of everything we have added on
top of upstream, organised by file. Update it whenever a file in its list is
added, changed or removed.

## Branch model — important

- **`main`** is a mirror of upstream `ory/polis`. Never put Precisely changes
  here.
- **`precisely`** carries all of our changes, on top of `main`, and is the branch
  we build and deploy manually to our environments.

Upstream syncs land on `main`; `precisely` is then rebased onto `main`. Because
we rebase, **commit ids are not stable — never refer to our changes by commit
id**, in documentation or anywhere else. Identify them by file instead:

```bash
git diff main...precisely --stat   # every file we touch
git diff main...precisely -- <path>  # our delta in one file
```

That diff should always match the file list in `PRECISELY.md`, except for
lockfiles (see below). If it does not, either `PRECISELY.md` is stale or
something of ours leaked onto `main`.

Default to working on `precisely`. When making a change, first ask whether it
belongs upstream or is genuinely Precisely-specific — we want the delta against
upstream to stay as small as possible, because every line of it is a rebase
conflict waiting to happen.

## Where our changes live

Files we add (upstream never touches them):

- `pages/api/precisely/**` — our unauthenticated, read-only internal API for
  directory-sync and SSO data.
- `Makefile`, `cloudbuild.yaml`, `deploy_shelob.sh` — our build and deploy.
- `PRECISELY.md`, `CLAUDE.md`.

Upstream files we modify (these are the rebase conflict points):

- `npm/src/directory-sync/scim/DirectoryUsers.ts` — SCIM user PATCH rewritten on
  the `scim-patch` library, plus an Azure `manager` workaround. **The only file
  we modify inside the vendored `npm/` library.**
- `npm/package.json` — declares the packages we add. `scim-patch` is currently
  the only one; record any new package in `PRECISELY.md` too.
- `proxy.ts` — one line adding `/api/precisely/**` to `unAuthenticatedApiRoutes`.

Everything else is upstream and should be left alone.

Lockfiles are the exception to all of the above. `npm/package-lock.json` and the
root `package-lock.json` are generated, not maintained: they differ from `main`
only because of the packages we declare, so they are not listed as our changes and
do not need documenting when they move. Both have to be regenerated — the image is
built with `npm ci` from the root lockfile, which is where npm records the `npm/`
workspace's dependency tree. On a rebase conflict, take upstream's lockfile and
regenerate rather than hand-merging it:

```bash
git checkout main -- npm/package-lock.json
cd npm && npm install     # regenerates npm/package-lock.json
cd .. && npm install      # regenerates the root package-lock.json
```

## Layout

- `pages/` — Next.js pages and API routes (the deployed app).
- `npm/` — the `@boxyhq/saml-jackson` library, vendored as a workspace. All SSO
  and directory-sync logic lives here; the app imports it as
  `@boxyhq/saml-jackson`.
- `lib/` — app-side helpers; `@lib/jackson` returns the initialised singleton
  controllers (`directorySyncController`, `connectionAPIController`,
  `oauthController`, …).
- `internal-ui/` — shared admin UI components, its own npm package.
- `ee/` — enterprise features. `e2e/` — Playwright tests.

Path aliases: `@lib/*`, `@components/*`, `@styles/*`, `@ee/*`.

## Commands

```bash
npm install            # also installs npm/ and internal-ui/ via the prepare script
npm run dev            # dev server on :5225, JACKSON_API_KEYS=secret, in-memory DB
npm run dev-dbs        # start the local databases in docker
npm run postgres       # dev server against local postgres

npm run check-types    # tsc --noEmit
npm run check-lint
npm run check-format   # prettier --check .   (npm run format to fix)
cd npm && npm test     # library tests (tap) — run these after touching npm/src
npm run test:e2e       # Playwright, needs .env.test.local
```

Run `check-types`, `check-lint` and `check-format` before committing. Touching
`npm/src/directory-sync/**` means running the library tests too.

## Deployment

Cloud Build (`cloudbuild.yaml`) builds
`europe-west3-docker.pkg.dev/precisely-production/services/jackson:$SHORT_SHA`
and calls Shelob to roll out the `jackson` deployment in the `provisioning`
namespace. `make docker-push` does the same build/push by hand. See
`PRECISELY.md` for the substitutions.

## Conventions

- Prettier config is in `.prettierrc.js` — single quotes, 110 columns. Match the
  surrounding style; don't reformat upstream files you aren't otherwise editing.
- Keep upstream files untouched unless the change is genuinely required, and keep
  each Precisely change in its own focused commit so it survives rebases.
- New Precisely-only API routes go under `pages/api/precisely/`, not into
  upstream's `pages/api/v1/`.
- `/api/precisely/**` is exempt from authentication in `proxy.ts`. Anything added
  there is reachable without credentials by whoever can reach the pod, so it must
  stay read-only and cluster-internal.
