# Precisely changes to Ory Polis

This document describes everything Precisely has added on top of upstream
[ory/polis](https://github.com/ory/polis) (formerly `boxyhq/jackson`). It is the
reference for what lives in the `precisely` branch and why.

**Keep this document up to date whenever a file in the list below is added,
changed or removed.** It is organised by file, not by commit, because the
`precisely` branch is rebased onto `main` and commit ids do not survive that.

## Branch model

- **`main`** — a mirror of upstream `ory/polis`. Nothing of ours goes here.
- **`precisely`** — our branch. All Precisely-specific changes live here, on top
  of `main`. This is the branch we build and deploy.

Upstream is pulled into `main`, then `precisely` is rebased onto `main`.
`git diff main...precisely --stat` shows the complete set of files we touch; it
should always match the list below, with one exception — see _Lockfiles_ below.

## Files we own or modify

| File                                            | Kind     | Purpose                                          |
| ----------------------------------------------- | -------- | ------------------------------------------------ |
| `PRECISELY.md`, `CLAUDE.md`                     | added    | This document and the repo working guide         |
| `Makefile`                                      | added    | Manual container build and push                  |
| `cloudbuild.yaml`                               | added    | Cloud Build pipeline                             |
| `deploy_shelob.sh`                              | added    | Rollout call to Shelob                           |
| `.github/workflows/precisely.yaml`              | added    | Our CI — checks, build and tests, pushes nothing |
| `pages/api/precisely/**`                        | added    | Read-only internal directory-sync and SSO API    |
| `proxy.ts`                                      | modified | Exempts `/api/precisely/**` from authentication  |
| `npm/src/directory-sync/scim/DirectoryUsers.ts` | modified | SCIM user PATCH rewritten on `scim-patch`        |
| `npm/package.json`                              | modified | Declares the dependencies we add (see below)     |

## Dependencies we add

Upstream's dependencies are left alone. We add:

| Package      | Declared in        | Why                                                 |
| ------------ | ------------------ | --------------------------------------------------- |
| `scim-patch` | `npm/package.json` | Applies SCIM PATCH operations — see section 3 below |

If a Precisely change needs a new package, record it here as well as in the
relevant `package.json`.

## Lockfiles

`npm/package-lock.json` and the root `package-lock.json` are **generated
artifacts**, not changes we maintain. They appear in `git diff main...precisely`
purely as a consequence of the packages listed above, so they are deliberately
absent from the file table and need no entry here when they move.

Both matter: the container image is built with `npm ci` from the **root**
lockfile, which is where npm records the `npm/` workspace's dependency tree. A
root lockfile that does not list `scim-patch` makes `npm ci` fail.

After an upstream sync, do not hand-merge a lockfile conflict. Take upstream's
version and regenerate it, so it picks our added packages back up:

```bash
git checkout main -- npm/package-lock.json
cd npm && npm install     # regenerates npm/package-lock.json
cd .. && npm install      # regenerates the root package-lock.json
```

Commit the regenerated lockfiles alongside the change that needed them.

## 1. Build and deployment

### `Makefile`

Builds and pushes the container image manually:

```
make            # docker build, tags :$(git describe --always) and :latest
make docker-push
```

Image name: `europe-west3-docker.pkg.dev/precisely-production/services/jackson`.

### `cloudbuild.yaml` + `deploy_shelob.sh`

Google Cloud Build pipeline:

1. Read `SHELOB_SECRET_HEADER` from Secret Manager into `.shelob`.
2. `docker build` and push
   `europe-west3-docker.pkg.dev/precisely-production/services/jackson:$SHORT_SHA`.
3. Run `deploy_shelob.sh $_CLUSTER jackson $SHORT_SHA provisioning`, which POSTs
   `{deployment, tag, namespace}` to Shelob to roll out the new image.

Substitutions used:

- `_CLUSTER` — `staging` selects `shelob.stg.precisely.se`, anything else
  selects `shelob.precisely.se`.
- `_SHELOB_TARGETS` — optional, space-separated list of Shelob hosts. When set,
  it overrides the `_CLUSTER`-derived host and the script posts to every target,
  failing if any of them fails.

The deployment always targets the `jackson` deployment in the `provisioning`
namespace.

### `.github/workflows/precisely.yaml`

Our GitHub Actions CI. It runs on pushes and pull requests against `precisely`,
and on `workflow_dispatch`. Two jobs:

- **`ci`** — `check-lint`, `check-types`, `check-format`, `check-locale`,
  `npm run build`, the `npm/` library tests, and the Playwright e2e suite against
  `mock-saml`. The `env` block is copied verbatim from upstream's `ci` job, so it
  should be re-copied if upstream changes it.
- **`image`** — builds the `Dockerfile` with `push: false`, purely to catch a
  Dockerfile that stopped building after an upstream sync.

#### Postgres only

Upstream's `ci` job runs nine service containers, because
`npm/test/db/db.test.ts` exercises every storage engine Polis supports —
redis, mongo, mysql, mariadb, mssql, dynamodb, planetscale and cockroachdb — from
a hardcoded list with no way to select one. We run Postgres and nothing else, so
that job spends most of its time pulling and health-checking databases we do not
use.

We therefore keep only two services, `postgres` (the app under e2e) and
`mocksaml`, and move `npm/test/db/db.test.ts` aside before running the tests:

```yaml
- name: Skip the multi-engine storage suite
  run: mv npm/test/db/db.test.ts "${RUNNER_TEMP}/db.test.ts.skipped"
```

`mv` rather than a `tap --exclude` flag, because `--exclude` does not filter the
files `npm run test` passes positionally, and spelling the tap flags out in the
workflow would drift the moment upstream changed them. If upstream renames the
file, this step fails loudly instead of quietly skipping nothing.

What this gives up is the storage layer's own test coverage, Postgres included.
That is upstream code we do not modify, and the Postgres path is still covered
end to end by the e2e run, which drives the real app against Postgres.

The `db:migration:run:planetscale` step and the cockroachdb `docker-compose` step
are dropped for the same reason. No migration step replaces them: `manualMigration`
defaults to false (`npm/src/db/sql/sql.ts`) and `DB_MANUAL_MIGRATION` is unset, so
TypeORM synchronizes the Postgres schema on boot.

`PLANETSCALE_URL`, `DYNAMODB_URL` and the `AWS_*` variables in `env` are dead now.
They are kept so the block stays a verbatim copy of upstream's.

**It publishes nothing.** There is no registry login, no `npm publish`, no image
push and no cosign/SBOM step, and the workflow requests only `contents: read`.
Deployment remains Cloud Build (`cloudbuild.yaml`), triggered by hand.

#### Upstream's workflow

`.github/workflows/main.yml` is upstream's, is **not** modified by us, and is
deliberately absent from the file table above. It pushes images to Docker Hub and
GHCR and publishes to npm, all gated on `refs/heads/release` and `beta-v*` tags —
refs we never create — but it would still run its build on every push to `main`
and twice a week on a cron.

Rather than delete it and take a modify/delete conflict on every sync (18 of the
169 commits in the last upstream sync touched it), it is switched off in the
repository's Actions settings:

```bash
gh workflow disable "CI" --repo Preciselyco/jackson
gh api repos/Preciselyco/jackson/actions/workflows \
  --jq '.workflows[] | "\(.state)\t\(.path)"'   # expect disabled_manually
```

That state is held by GitHub, not by the file, so it survives upstream editing
the workflow. It does **not** cover a _new_ workflow file arriving from upstream,
which would be active from the moment it lands — so after an upstream sync, check
the workflow list above and disable anything new.

## 2. `/api/precisely/**` read-only API

Ported from our old `jackson-api` service. These live under
`pages/api/precisely/` and expose Polis's internal directory-sync and SSO state
in a shape our services consume directly, without going through the paginated
upstream `/api/v1` API.

`proxy.ts` adds `/api/precisely/**` to `unAuthenticatedApiRoutes`, so **these
endpoints have no authentication of their own**. They must only be reachable
from inside the cluster — never expose them on a public ingress.

All handlers ignore `req.method`, so every verb behaves as a GET.

### Endpoints

| Method | Path                                                 | Returns                                              |
| ------ | ---------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/precisely`                                     | `{}` — liveness ping                                 |
| GET    | `/api/precisely/dsync`                               | All directory configs                                |
| GET    | `/api/precisely/dsync/:directoryId`                  | Full directory snapshot (see below)                  |
| GET    | `/api/precisely/dsync/:directoryId/users`            | `{ users }` — all users in the directory             |
| GET    | `/api/precisely/dsync/:directoryId/users/:id`        | `{ user }`                                           |
| GET    | `/api/precisely/dsync/:directoryId/users/:id/groups` | `{ groups }` — groups the user is a member of        |
| GET    | `/api/precisely/dsync/:directoryId/groups`           | `{ groups }` — all groups in the directory           |
| GET    | `/api/precisely/dsync/:directoryId/groups/:id`       | `{ group, members }` — members are `{ user_id }`     |
| GET    | `/api/precisely/sso/:clientID`                       | `{ conn }` — the SSO connection for a client ID      |
| GET    | `/api/precisely/sso/code/:code`                      | `{ conn }` — the SSO connection behind an OAuth code |

Every `dsync` handler first resolves the directory via
`dsync.directories.get(directoryId)` and then scopes the user/group API with
`setTenantAndProduct(directory.tenant, directory.product)`. Errors from the Polis
controllers are returned as-is with their `code` as the HTTP status.

### The directory snapshot (`/api/precisely/dsync/:directoryId`)

The one endpoint that does real work. It fetches all users, all groups and all
group memberships, then cross-links them and returns:

```jsonc
{
  "id": "...", "name": "...", "tenant": "...", "product": "...", "type": "...",
  "users":  [{ "id", "email", "first_name", "last_name", "active", "groups": ["<group name>"] }],
  "groups": [{ "id", "name", "members": ["<user email>"] }]
}
```

Users are sorted by email, groups by name. Memberships that reference an unknown
user or group are silently dropped.

### `/api/precisely/sso/code/:code`

Resolves an OAuth authorization code back to the SSO connection that issued it.
The code has the form `<encryptionKey>.<storeKey>`; the handler reaches into the
OAuth controller's private `codeStore`, decrypts the record with Polis's own
`decrypt()` helper, and looks up the connection by the `clientID` it contains.

This depends on Polis internals (`(oauth as any).codeStore`, the deep import of
`@boxyhq/saml-jackson/src/db/encrypter`, and the code's encoding). **Re-check it
after every upstream sync.**

### Known quirks

- Pagination loops use `pageLimit: 25` and treat an error as "skip this page and
  keep going" rather than aborting, so a partial result can be returned as a
  success.
- `/users/:id/groups` walks every group in the directory and calls
  `isUserInGroup` for each one; it is O(number of groups) per request.
- Several handlers deep-import from `@boxyhq/saml-jackson/src/...` rather than
  the package root, which couples them to upstream's file layout.

## 3. SCIM user PATCH rewritten on `scim-patch`

`npm/src/directory-sync/scim/DirectoryUsers.ts`, method `patch()`.

Upstream parses SCIM PATCH operations with its own `parseUserPatchRequest` /
`updateRawUserAttributes` helpers, which mishandle some operations — notably
patches against `emails`, where a changed work email was not applied.

We replaced that with the
[`scim-patch`](https://www.npmjs.com/package/scim-patch) library, our one added
dependency (see _Dependencies we add_ above):

- Each operation in `Operations` is applied **individually** to `user.raw` in a
  `try`/`catch`, so one malformed operation from an IdP does not fail the whole
  request. Failures are logged and skipped.
- The patched raw object then becomes the user's `raw` attribute wholesale
  (upstream merged deltas instead).
- The flat columns are derived from the patched raw object: `active`,
  `first_name` (`name.givenName`), `last_name` (`name.familyName`) and `email`
  (the `emails` entry with `type === 'work'`). Because the patched raw object is
  the source of truth, `first_name` and `last_name` are always rewritten, and
  fall back to `''` when an `op: "remove"` has taken the field away — upstream
  asserts this in `test/dsync/users.test.ts`.

### Extension schema URNs in no-path operations

`normalizePatchOperation()` in the same file.

`scim-patch` reads the keys of a **no-path** operation's value object as dotted
attribute paths. An extension schema URN such as
`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User` contains a dot, so
it gets split and the attributes land under a truncated key. Entra sends the
enterprise extension in exactly this shape:

```json
{ "op": "replace", "value": { "urn:...:enterprise:2.0:User": { "department": "Engineering" } } }
```

Before patching we rewrite URN-keyed entries of a no-path operation into
path-based operations (`urn:...:User:department`), which `scim-patch` resolves
correctly. Every other key is left in a single no-path operation so the merge
semantics of a no-path operation are preserved. Path-based operations were
already handled correctly and are passed through untouched.

### Azure manager workaround

Entra ID / Azure AD sends a PATCH that sets
`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User.manager` to a bare
string, and then fails to parse its own value on the next read. After patching we
detect a string `manager` and rewrap it as `{ value: <string> }`.

This is a workaround for IdP behaviour, not a SCIM correctness fix — keep it
until Azure stops doing this.

### Upstream-sync risk

This is the only change we make to the vendored `npm/` library, and it is a
rewrite of a method upstream actively maintains. Expect conflicts here on rebase,
and re-run the directory-sync tests (`cd npm && npm test`) afterwards.
