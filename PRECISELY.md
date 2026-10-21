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
| `deploy_shelob.sh`                              | added    | Rollout call to Shelob                           |
| `.github/workflows/precisely.yaml`              | added    | Our CI — checks, tests, and the image push       |
| `pages/api/precisely/**`                        | added    | Read-only internal directory-sync and SSO API    |
| `lib/precisely.ts`                              | added    | Helpers shared by the `/api/precisely` handlers  |
| `lib/precisely/**`                              | added    | Directory-sync list API: contract, SQL, views    |
| `lib/adminPortalSSO.ts`                         | added    | Admin-portal tenant check for SAML sign-in       |
| `e2e/precisely/**`                              | added    | Tests for the `/api/precisely` API and the above |
| `pages/api/auth/[...nextauth].ts`               | modified | Refuses SAML sign-in from non-admin tenants      |
| `proxy.ts`                                      | modified | Puts `/api/precisely/**` behind the API key      |
| `npm/src/directory-sync/scim/DirectoryUsers.ts` | modified | SCIM user PATCH rewritten on `scim-patch`        |
| `npm/package.json`                              | modified | Declares the dependencies we add (see below)     |
| `Dockerfile`                                    | modified | Runtime Node trusts the system CA store only     |

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

Image name: `europe-docker.pkg.dev/precisely-production/services/jackson`.

### `deploy_shelob.sh`

The manual rollout. Run
`deploy_shelob.sh <cluster> jackson <short sha>-gh provisioning`; it POSTs
`{deployment, tag, namespace}` to Shelob to roll out that image.

Shelob authenticates the call with a short-lived token for the
`shelob-deployer` Kubernetes service account of the target cluster. The script
creates one itself with
`kubectl --context <context> create token shelob-deployer -n default --audience=shelob --duration=10m`
and sends it as `Authorization: Bearer <token>`, through a temporary header
file rather than the command line. Creating the token needs the cluster's
kubectl context configured and membership of developers@precisely.se; the
script stops with an error if it gets no token.

- `<cluster>` — `staging` selects `shelob.stg.precisely.se` and the
  `precisely-staging` context, `production` selects `shelob.precisely.se` and
  the `precisely-production` context. Any other value is refused.
- `SHELOB_TARGETS` — optional environment variable, a space-separated list of
  Shelob hosts. When set, it overrides the cluster-derived host and the script
  posts to every target, failing if any of them fails. The token still comes
  from the `<cluster>` context and is only valid for that cluster's Shelob, so
  every target must belong to it.
- `IMAGE_REPOSITORY` — optional environment variable. Set it to `services-pr` to
  roll out an image a pull request built (see _The image push_ below); the script
  then adds `"image_repository": "services-pr"` to the body, the same field the
  shared `shelob-deploy` action sends. Empty means the release repository,
  `services`. Any other value, or `services-pr` with a cluster other than
  `staging`, is refused.

Deploying a pull request's image to staging:

```bash
IMAGE_REPOSITORY=services-pr ./deploy_shelob.sh staging jackson <short sha>-gh provisioning
```

`<short sha>` is the first seven characters of the pull request's head commit.
The token is created through the `precisely-staging` context.

Cloud Build and `cloudbuild.yaml` are retired.

The deployment always targets the `jackson` deployment in the `provisioning`
namespace.

### `.github/workflows/precisely.yaml`

Our GitHub Actions CI. It runs on pushes and pull requests against `precisely`,
and on `workflow_dispatch`. Two jobs:

- **`ci`** — `check-lint`, `check-types`, `check-format`, `check-locale`,
  `npm run build`, the `npm/` library tests, and the Playwright e2e suite against
  `mock-saml`, then `e2e/precisely` once more against an unencrypted store (see
  _Directory-sync list API_ → _Tests_). The `env` block is copied verbatim from
  upstream's `ci` job, so it should be re-copied if upstream changes it.
- **`image`** — builds the `Dockerfile` on every run, which is what catches a
  Dockerfile broken by an upstream sync, and pushes it to our Artifact Registry:
  on a merge to `precisely` to `services`, and for a pull request from a branch
  of this repository to `services-pr`. A pull request from a fork builds and
  stops — it never authenticates or pushes.

#### The image push

```
europe-docker.pkg.dev/precisely-production/services/jackson:<short sha>-gh      # merge to precisely
europe-docker.pkg.dev/precisely-production/services-pr/jackson:<short sha>-gh   # same-repo pull request
```

`<short sha>-gh` is the release tag every service uses. For a pull request the
short sha is the pull request's **head** commit, not the merge commit GitHub
checks out.

Which of the two (if either) is pushed is decided once, in the `Set build vars`
step, as its `push_repo` output; the auth, login and push steps all run only when
it is non-empty. `services-pr` is the pull request registry the other services
use too: its images are for deploying to **staging by hand** (see
`deploy_shelob.sh` above), never to production. A pull request does not need
`pull_request_target` for this — a branch of this repository already gets the
OIDC token on `pull_request`, and a fork's run never reaches the auth step.

Registry auth is Workload Identity Federation, not a service account key. **This
repository is public** — it is our fork of `ory/polis`, and GitHub does not allow
a fork of a public repository to be made private — so a long-lived key stored
here would be one careless step away from a world-readable log or artifact, and
would stay valid until somebody rotated it. A federated token lasts minutes and
is only ever issued to a workflow run in this repository.

None of the values in the workflow is a secret, so they are written out rather
than kept in an org secret:

|                                |                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `workload_identity_provider`   | `projects/179949444356/locations/global/workloadIdentityPools/github-actions/providers/github-actions` |
| `service_account` (merge)      | `github-actions-jackson@precisely-production.iam.gserviceaccount.com`                                  |
| `service_account` (PR, branch) | `github-actions-jackson-pr@precisely-production.iam.gserviceaccount.com`                               |

All are managed in the `iap` repo, `gcp-github` (Pulumi stack `production`). The
provider is its `workloadIdentityProvider` output, and the merge account its
`jacksonServiceAccountEmail` output; the pull request account comes from the
sibling `iap` change and, until that is applied, the pull request push fails to
authenticate. The pool and provider are shared with the other Precisely
repositories; the two service accounts are not. The `Set build vars` step picks
the account, as its `service_account` output, alongside `push_repo`:

- **`github-actions-jackson`** — used on a push to `precisely`. Bound only to
  `refs/heads/precisely`, and holds `roles/artifactregistry.writer` on the
  `services` repository only.
- **`github-actions-jackson-pr`** — used for a pull request from a branch of this
  repository. Bound only to the `pull_request` OIDC subject, and holds
  `roles/artifactregistry.writer` on the `services-pr` repository only.

Neither has any project-level role. Splitting them means code under review can
never write a release image: a pull request run can only mint a token for the PR
account, and that account cannot write to `services`.

That separation is deliberate. The shared `github-actions` service account also
holds `roles/container.developer` and `roles/storage.admin`, so binding a public
repository to it would let anything running on `precisely` deploy to our clusters
and read or delete any bucket in the project.

Only the image job asks for `id-token: write`, which is what lets it mint the
OIDC token; it grants no access to this repository. The auth step hands docker an
access token directly, so there is no gcloud and no credentials file.

It is a plain `docker build` / `docker push` rather than `docker/build-push-action`
on purpose. BuildKit's default provenance and SBOM attestations publish an OCI
index, where the clusters and Shelob expect a plain image manifest. The
cost is losing the cross-run buildx cache, which is worth roughly 2½ minutes on
the image job.

The image is built **before** authenticating, and `Dockerfile` line 39 is
`COPY . .`, so nothing credential-shaped may be in the workspace when it runs.
This repository is **public**. Three things keep it that way: the build runs
first; the auth step writes no credentials file (`create_credentials_file:
false`); and both checkouts set `persist-credentials: false`, so the job token is
not in `.git/config` either.

**Nothing here deploys.** The push is where this workflow stops: `deploy_shelob.sh`
is never called from it, and rolling an image out to a cluster stays a deliberate,
separate act. The pushed digest is written to the job summary so it can be handed
to a deploy.

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

**It publishes nothing upstream.** There is no `npm publish`, no Docker Hub or
GHCR login and no cosign/SBOM step; the only registry it touches is our own
Artifact Registry. Rollout is `deploy_shelob.sh`, run by hand.

#### Upstream's workflow

`.github/workflows/main.yml` is upstream's, is **not** modified by us, and is
deliberately absent from the file table above. It pushes images to Docker Hub and
GHCR and publishes to npm, all gated on `refs/heads/release` and `beta-v*` tags —
refs we never create — but it would still run its build on every push to `main`
and twice a week on a cron.

Rather than delete it and take a modify/delete conflict on every sync (18 of the
169 commits in the last upstream sync touched it), it is left switched off.

It is off today only because workflows in a fork start disabled: GitHub reports
it as `disabled_fork`, not `disabled_manually`. To make it hold even if Actions
are enabled for the fork, disable it explicitly:

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

### Authentication

`proxy.ts` adds `/api/precisely/**` to the API-key branch, the one that already
guards `/api/v1/**` and `/api/internals/**`. Every request — the bare
`/api/precisely` ping included — must carry one of the keys in
`JACKSON_API_KEYS` (or `API_KEYS`):

```
Authorization: Bearer <key>
```

kvasir sends its key this way. A request without a valid key gets a 401 from the
proxy and never reaches a handler. Paths that do not match the glob exactly
(another case, a doubled slash) fall through to the proxy's default deny.

That one array entry is the whole of our `proxy.ts` delta.

An API key unlocks SSO client secrets here, so the endpoints must stay read-only
and cluster-internal — never expose them on a public ingress — and return only
what our consumers read.

`e2e/precisely/auth.spec.ts` covers this: no key, a wrong key and odd spellings
of the path are never answered with a 200; a valid key is.

### Handler behaviour

The shared pieces live in `lib/precisely.ts`:

- **GET only**, except the list and lookup routes of the directory-sync list API
  below, which are POST (`allowPost`). Any other method is answered with 405 and
  `Allow: GET` (or `POST`).
- **Error status.** Errors from the Polis directory-sync controllers are returned
  with their `code` as the HTTP status. Thrown errors use their `statusCode`, or
  500 when they carry none.
- **Pagination.** `fetchAllPages` reads 25 at a time. A failing page is retried;
  after three consecutive failures the request is answered with 502, so a partial
  result is never returned as a success.

### Endpoints

| Method | Path                                                 | Returns                                              |
| ------ | ---------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/precisely`                                     | `{}` — liveness ping                                 |
| GET    | `/api/precisely/dsync`                               | Every directory, trimmed (see below)                 |
| GET    | `/api/precisely/dsync/:directoryId`                  | Full directory snapshot (see below)                  |
| GET    | `/api/precisely/dsync/:directoryId/users`            | `{ users }` — all users in the directory             |
| GET    | `/api/precisely/dsync/:directoryId/users/:id`        | `{ user }`                                           |
| GET    | `/api/precisely/dsync/:directoryId/users/:id/groups` | `{ groups }` — groups the user is a member of        |
| GET    | `/api/precisely/dsync/:directoryId/groups`           | `{ groups }` — all groups in the directory           |
| GET    | `/api/precisely/dsync/:directoryId/groups/:id`       | `{ group, members }` — members are `{ user_id }`     |
| POST   | `/api/precisely/dsync/:directoryId/users/list`       | A page of users — see _Directory-sync list API_      |
| POST   | `/api/precisely/dsync/:directoryId/groups/list`      | A page of groups — see _Directory-sync list API_     |
| GET    | `/api/precisely/dsync/:directoryId/summary`          | The directory with user and group counts             |
| POST   | `/api/precisely/dsync/users/lookup`                  | A user's records in every directory, by email        |
| GET    | `/api/precisely/sso/:clientID`                       | `{ conn }` — the SSO connection for a client ID      |
| GET    | `/api/precisely/sso/code/:code`                      | `{ conn }` — the SSO connection behind an OAuth code |

`/api/precisely/dsync` returns each directory as
`{ id, name, tenant, product, type, deactivated }` — no SCIM endpoint or secret,
no webhook config. Both `sso` endpoints return only
`{ conn: { clientID, clientSecret } }`, which is what kvasir needs for the code
exchange, and 404 when there is no connection. The other `dsync` endpoints return
Polis's user and group records unchanged; kvasir reads the users' `raw`
attributes.

Every `dsync` handler first resolves the directory via
`dsync.directories.get(directoryId)` and then scopes the user/group API with
`setTenantAndProduct(directory.tenant, directory.product)`.

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

### Directory-sync list API (DEV-1206)

The backoffice used to read whole directories through
`/api/precisely/dsync/:directoryId` and filter, sort and page them in kvasir. A
directory of ~6k users timed out. These routes do that work in Postgres instead,
over SQL views of Jackson's key-value store, and implement kvasir's backoffice v2
list contract (`controllers/backoffice/listing/listing.go` and
`v2_list_openapi.yaml` in kvasir), so kvasir can forward a list request as is.
The code is in `lib/precisely/list.ts` (the contract), `lib/precisely/db.ts`
(views, indexes, SQL access) and `lib/precisely/dsync.ts` (the queries).

The list and lookup routes are POST because they take a JSON query body. They are
read-only like every other route here. JSON is camelCase. Errors go through
`sendError` as `{ "error": { "message": "..." } }`: 400 for a request outside the
contract (the message names the field or operator), 404 for an unknown directory,
405 with `Allow` for another method, and 501 when the store can't serve them (see
_Limitations_).

#### The list contract

`POST /api/precisely/dsync/:directoryId/users/list` and `…/groups/list` take
`{ query?, filters?: [{ field, op, value }], sort?: [{ field, desc? }], limit?, cursor? }`
and answer `{ items, nextCursor: string | null, total: number }`.

- `limit`: 1–200; omitted or 0 means 50.
- `query`: trimmed, then a case-insensitive substring match on the list's search
  fields.
- `filters`: ANDed. Operators by field type: text `eq`, `in`, `contains`; number
  `eq`, `in`, `gte`, `lte`, `between` (inclusive); boolean `eq`. `in` takes 1–100
  values, `between` `[lo, hi]`. `contains` is case-insensitive, and `%` and `_`
  match literally. Every field here is integral when numeric and never null, so a
  fraction and `isNull` are both a 400.
- `sort`: at most 5 keys, no repeats. With no sort, the list's default applies.
  `id` is appended as the final key (ascending) unless already present, so the
  order is total. Ordering is `NULLS LAST` and uses the database collation.
- `cursor`: the previous page's `nextCursor`. It is opaque: base64url JSON of the
  last row's sort-key values and a fingerprint (SHA-256) of the trimmed query, the
  filters and the effective sort. A cursor sent with a different query, filters or
  sort is a 400; a changed `limit` is fine. Values in a cursor are type-checked,
  since it isn't signed. `total` ignores the cursor.
- Unknown keys (in the body, a filter or a sort key), `null` for anything but
  `cursor`, unknown fields and operators not allowed for a field's type are all a 400.

The semantics match kvasir's; the cursor bytes do not, and needn't, because kvasir
passes it through.

**Users** (`users/list`). Fields, all filterable and sortable: `id`, `email`,
`firstName`, `lastName` (text), `active` (boolean), `groupCount` (number). Default
sort `email`. Search: `id`, `email`, `firstName`, `lastName`. Item:

```jsonc
{ "id", "email", "firstName", "lastName", "active", "groupCount",
  "groups": [{ "id", "name" }] }   // all of the user's groups, by name
```

**Groups** (`groups/list`). Fields, all filterable and sortable: `id`, `name`
(text), `memberCount` (number). Default sort `name`. Search: `id`, `name`. Item:

```jsonc
{ "id", "name", "memberCount",
  "members": [{ "id", "email", "firstName", "lastName" }] }  // first 50 by email
```

`members` is capped at 50; `memberCount` is the full count.

Missing text values read as `''`, a missing `active` as `true` (Jackson's own
default), and `active` stored as a string (`"true"`/`"false"`, any case, which some
IdPs send) as the boolean. A membership whose user or group is not (or no longer)
in the directory is left out of every count and list.

#### `GET /api/precisely/dsync/:directoryId/summary`

`{ id, name, tenant, product, type, deactivated, userCount, groupCount }`; 404 for
an unknown directory.

#### `POST /api/precisely/dsync/users/lookup`

Body `{ email, directoryIds? }`. Finds the directory users whose email matches
`email`, both sides trimmed and lower-cased, in every directory, or only in
`directoryIds` (at most 100) when given. Answers

```jsonc
{ "matches": [{ "directory": { "id", "name", "tenant", "product", "type" },
                "user": { "id", "email", "firstName", "lastName", "active" },
                "groups": [{ "id", "name" }] }] }
```

sorted by directory name. An empty or non-string `email`, an unknown key or a
`null` is a 400.

#### Directory scoping

Jackson keeps a tenant/product's records in one namespace
(`dsync:users:<tenant>:<product>`, `dsync:groups:…`, `dsync:members:…`), and two
directories can share a tenant/product (two of production's 35 do). Only some user
records carry a `directoryId`. So a directory's users and groups are found
through Jackson's own `directoryId` secondary index in `jackson_index`, whose key
is `<namespace>:directoryId:<RIPEMD-160 of the directory ID>`; `lib/precisely/dsync.ts`
computes it with Jackson's exported `keyDigest`/`keyForIndex`. Memberships are taken
from the directory's members namespace and kept only where both the group and the
user belong to the directory.

None of this goes through the `dsync.users` / `dsync.groups` controllers, whose
`setTenantAndProduct()` is shared state across concurrent requests.

#### Views and indexes

`lib/precisely/db.ts` owns these objects in Jackson's database. Nothing in
Jackson's TypeORM schema refers to them.

| Object                                       | Over                                |
| -------------------------------------------- | ----------------------------------- |
| view `precisely_dsync_directories`           | `dsync:config`                      |
| view `precisely_dsync_users`                 | `dsync:users:*` (incl. `email_key`) |
| view `precisely_dsync_groups`                | `dsync:groups:*`                    |
| view `precisely_dsync_memberships`           | `dsync:members:*`                   |
| index `precisely_dsync_users_id_idx`         | users' `id`                         |
| index `precisely_dsync_users_email_idx`      | users' `lower(btrim(email))`        |
| index `precisely_dsync_groups_id_idx`        | groups' `id`                        |
| index `precisely_dsync_members_group_id_idx` | memberships' `group_id`             |
| index `precisely_dsync_members_user_id_idx`  | memberships' `user_id`              |

The views turn the JSON `value` into columns, parsing each record once (a
`LATERAL … OFFSET 0` subquery; Postgres would otherwise parse the record again for
every column). The indexes are partial expression indexes on `jackson_store`,
limited to their namespace prefix and to unencrypted rows (`iv IS NULL`). Two rules
keep them working:

- An index expression and predicate must be spelled exactly like the view's, or
  the planner won't use it. The views and indexes share their SQL fragments for
  that reason.
- Every index key is an expression, never a plain column. TypeORM synchronizes the
  schema on every boot and drops indexes it doesn't know, but it only sees indexes
  with a plain key column (it joins `pg_index.indkey` to `pg_attribute`). Adding a
  plain column (`namespace`, say) to one of these indexes would get it dropped on
  the next restart.

**How they get to a database.** There is no migration step. The first request to
any of these routes in a process creates them:

1. The views, with `CREATE OR REPLACE VIEW`, under a session advisory lock
   (`precisely_dsync_views`). The request waits for this; it takes milliseconds.
2. The indexes, in the background, with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`,
   which never locks `jackson_store` against Jackson's writes. A pod that can't get
   the `precisely_dsync_indexes` advisory lock leaves it to the pod that has it.
   An `INVALID` index left by a failed build is dropped and rebuilt. Requests don't
   wait: the queries are correct without the indexes, only slower. Failures are
   logged (`precisely: creating the dsync list indexes failed`) and retried on the
   next request.

So the first deploy needs no manual step, and the indexes appear on the first
backoffice request after it. A view that disappears while a process runs (see
below) is recreated on the next query that misses it.

Changing a view's columns later: `CREATE OR REPLACE VIEW` can only append columns,
so a change that renames, retypes or removes one must drop the view first (do it in
`viewStatements`, or by hand before the deploy). Changing an index's definition
needs a new index name, or a manual `DROP INDEX CONCURRENTLY` first.

#### Upgrade risk

The views depend on `jackson_store.value`. If an upstream change alters or drops
that column (or `key`, `namespace`, `iv`, `createdAt`, `modifiedAt`), TypeORM's
boot-time synchronization fails with "cannot alter type of a column used by a view
or rule" and Jackson keeps retrying its database connection, i.e. doesn't start. On
every upstream sync, check `npm/src/db/sql/entity/JacksonStore.ts` and
`JacksonIndex.ts` for changes. If there are any, drop the views on each database
just before deploying:

```sql
DROP VIEW IF EXISTS precisely_dsync_directories, precisely_dsync_users,
  precisely_dsync_groups, precisely_dsync_memberships;
```

The new pods recreate them on first use, and old pods still running recreate them
on their next miss. The indexes need no action: Postgres rebuilds an expression
index when its column's type changes and drops it with the column. If the view SQL
no longer fits the new schema, that first request fails with a 500 instead; fix
`lib/precisely/db.ts` before deploying. A change in how upstream builds store or
index keys (`npm/src/db/utils.ts`, `store.ts`, `sql/sql.ts`) or in the directory-sync
namespaces or index names would also break these routes silently (empty lists), so
re-run `e2e/precisely/dsync-list.spec.ts` after every sync.

#### Limitations

- **Postgres and unencrypted only.** The routes need `DB_ENGINE=sql`,
  `DB_TYPE=postgres` and no `DB_ENCRYPTION_KEY`; otherwise they answer 501 with a
  message saying which. Encrypted values can't be read in SQL. Production has no
  encryption key.
- **Jackson internals.** The SQL runs on Jackson's own TypeORM `DataSource`, reached
  through private fields (`directorySyncController.users.db.db.dataSource`), and
  depends on the store's key layout. Re-check both after every upstream sync.
- **Cost per request.** A list parses every user and membership record of the
  directory (for counts, sort and filters), since the JSON can't be read from the
  indexes alone. In production that is ~6k users and ~11k memberships for the
  largest directory.
- `memberCount`, `groupCount` and `total` are computed on every request; nothing is
  cached.

#### Tests

`e2e/precisely/dsync-list.spec.ts` seeds directories through SCIM (two on one
tenant/product, string `active` values, a deleted member, a 53-member group) and
covers every field and operator, multi-key sort, paging through duplicates,
fingerprint mismatch, rejections, summary, lookup, 404/405/401 and the 501 on an
encrypted store. `e2e/precisely/list-contract.spec.ts` unit-tests the contract
logic. CI runs them twice: in the main e2e run, whose environment encrypts the
store, only the 501 test runs; the step _e2e tests on an unencrypted store_ then
runs `e2e/precisely` again with `e2e/precisely/playwright.config.ts`, which starts a
second server on port 5226 without `DB_ENCRYPTION_KEY`, on its own database
(`PRECISELY_E2E_DB_URL`).

### Known quirks

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

## 4. Admin-portal SAML sign-in tenant check (DEV-1031)

Upstream's admin-portal sign-in (`pages/api/auth/[...nextauth].ts`) accepts any
Jackson code. Neither provider checks which connection issued it:

- `boxyhq-saml-idplogin` (IdP-initiated, `/admin/auth/idp-login`) exchanges the
  code itself with `client_id=dummy` and the app's own `CLIENT_SECRET_VERIFIER`
  (or an empty secret), so a code from **any** customer connection's IdP-initiated
  login becomes an admin session.
- `boxyhq-saml` (SP-initiated) takes `tenant`/`product` from the sign-in request,
  so a connection whose allowed redirect URLs include our own URL can do the same.

`lib/adminPortalSSO.ts` exports `isAdminPortalSSO(requested)`, true only when the
profile's `requested.tenant`/`product` equal `ADMIN_PORTAL_SSO_TENANT`/`_PRODUCT`.
`[...nextauth].ts` calls it in `authorize` for `boxyhq-saml-idplogin` and in the
`signIn` callback for `boxyhq-saml`; credentials and email sign-in are unchanged.
`e2e/precisely/admin-portal-sso.spec.ts` tests the check (it needs no browser or
server). Drop all three once upstream ships an equivalent check.

## 5. Runtime trusts the system CA store (DEV-1299)

Node ships its own copy of Mozilla's root store and uses it by default, ignoring
the image's `ca-certificates`. When a root has to be distrusted urgently — as with
the eMudhra intermediate key compromise (October 2026), where the bad chains end
at `emSign ECC Root CA - G3` — Alpine ships the fix days or weeks before Node
does. Jackson fetches IdP metadata and OIDC discovery/JWKS over TLS, so it must
not wait for Node.

The `runner` stage of `Dockerfile` therefore:

- adds `--use-openssl-ca` to `NODE_OPTIONS`, so Node verifies against OpenSSL's
  default store (`/etc/ssl/cert.pem` → Alpine's `ca-certificates-bundle`)
  **instead of** its bundled roots. `--use-system-ca` is not a substitute: it adds
  the system store to the bundled roots, so a root Node still bundles stays
  trusted. `NODE_EXTRA_CA_CERTS` keeps working either way.
- installs `ca-certificates-bundle>=20261020-r0`, the first Alpine release without
  `emSign ECC Root CA - G3`, so the build fails rather than ship an older store.
  Raise the floor when a later distrust needs a newer bundle.

The deployment's environment must not set `NODE_OPTIONS`, or it replaces this
value. Drop the flag once Node's bundled store is the one we want to follow again.
