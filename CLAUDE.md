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

- `pages/api/precisely/**` — our read-only internal API for directory-sync and
  SSO data, behind the API key.
- `lib/precisely.ts` — helpers shared by those handlers (GET-only check, error
  status, bounded pagination).
- `lib/adminPortalSSO.ts` — the admin-portal tenant check used by
  `[...nextauth].ts` (DEV-1031).
- `e2e/precisely/` — e2e tests for that API's authentication and handlers, and
  for the admin-portal tenant check.
- `Makefile`, `deploy_shelob.sh` — manual build/push and rollout.
- `.github/workflows/precisely.yaml` — our CI. Runs every check, the build and
  every test, and pushes the container to our Artifact Registry as
  `jackson:<short sha>-gh`: to `services` on a merge to `precisely`, to
  `services-pr` for a pull request from a branch of this repository (fork pull
  requests only build). It never deploys — `deploy_shelob.sh` is not called from
  it.
- `PRECISELY.md`, `CLAUDE.md`.

Upstream's own `.github/workflows/main.yml` is left untouched and is switched off
in the repository's Actions settings (`gh workflow disable "CI"`), so it is not
part of our delta. If an upstream sync adds a _new_ workflow file, it arrives
enabled — disable it too. See `PRECISELY.md`.

Upstream files we modify (these are the rebase conflict points):

- `npm/src/directory-sync/scim/DirectoryUsers.ts` — SCIM user PATCH rewritten on
  the `scim-patch` library, plus an Azure `manager` workaround. **The only file
  we modify inside the vendored `npm/` library.**
- `npm/package.json` — declares the packages we add. `scim-patch` is currently
  the only one; record any new package in `PRECISELY.md` too.
- `pages/api/auth/[...nextauth].ts` — refuses `boxyhq-saml` and
  `boxyhq-saml-idplogin` sign-in unless the profile was issued for the
  admin-portal tenant/product (DEV-1031). Drop it once upstream checks this.
- `proxy.ts` — one line adding `/api/precisely/**` to the API-key branch, next to
  `/api/v1/**` and `/api/internals/**`.

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

A merge to `precisely` builds and pushes
`europe-docker.pkg.dev/precisely-production/services/jackson:<short sha>-gh`
through `.github/workflows/precisely.yaml`. Nothing deploys it automatically:
rolling it out to the `jackson` deployment in the `provisioning` namespace is a
deliberate `./deploy_shelob.sh <staging|production> jackson <short sha>-gh provisioning`
call by hand. The script authenticates to Shelob with a short-lived token for
the cluster's `shelob-deployer` service account, which it creates with
`kubectl --context precisely-<cluster> create token` — that needs membership of
developers@precisely.se. See `PRECISELY.md` for details.

A pull request from a branch of this repository pushes
`europe-docker.pkg.dev/precisely-production/services-pr/jackson:<short sha>-gh`
(head commit's sha). That image is for staging only, deployed by hand with
`IMAGE_REPOSITORY=services-pr ./deploy_shelob.sh staging jackson <short sha>-gh provisioning`.

The two pushes use separate service accounts: `github-actions-jackson` (bound
to `refs/heads/precisely`, writes `services` only) for merges, and
`github-actions-jackson-pr` (bound to the `pull_request` subject, writes
`services-pr` only) for pull requests. `make docker-push` builds and pushes by
hand. Cloud Build is retired. See `PRECISELY.md`.

## Conventions

- Prettier config is in `.prettierrc.js` — single quotes, 110 columns. Match the
  surrounding style; don't reformat upstream files you aren't otherwise editing.
- Keep upstream files untouched unless the change is genuinely required, and keep
  each Precisely change in its own focused commit so it survives rebases.
- New Precisely-only API routes go under `pages/api/precisely/`, not into
  upstream's `pages/api/v1/`.
- `/api/precisely/**` requires an API key (one of `JACKSON_API_KEYS`, sent as
  `Authorization: Bearer <key>`), enforced in `proxy.ts`. A key grants read access
  to SSO client secrets, so the endpoints stay read-only, GET-only and
  cluster-internal, and return only the fields our consumers read.
