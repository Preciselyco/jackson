#!/usr/bin/env bash

set -e

CLUSTER=${1?param missing - cluster}
DEPLOYMENT=${2?param missing - deployment}
TAG=${3?param missing - tag}
NAMESPACE=${4?param missing - namespace}
# Optional. Set to services-pr to deploy an image built from a pull request;
# empty means the release repository. Staging only.
IMAGE_REPOSITORY=${IMAGE_REPOSITORY:-}

case "$CLUSTER" in
  staging)
    KUBE_CONTEXT=precisely-staging
    SUBDOMAIN=".stg"
    ;;
  production)
    KUBE_CONTEXT=precisely-production
    SUBDOMAIN=""
    ;;
  *)
    echo "cluster must be staging or production, got: $CLUSTER" >&2
    exit 1
    ;;
esac

if [[ -n "$IMAGE_REPOSITORY" && "$IMAGE_REPOSITORY" != "services-pr" ]]; then
  echo "IMAGE_REPOSITORY must be empty or services-pr" >&2
  exit 1
fi
if [[ -n "$IMAGE_REPOSITORY" && "$CLUSTER" != "staging" ]]; then
  echo "IMAGE_REPOSITORY is only allowed for the staging cluster" >&2
  exit 1
fi

IMAGE_REPOSITORY_FIELD=
if [[ -n "$IMAGE_REPOSITORY" ]]; then
  IMAGE_REPOSITORY_FIELD=",
    \"image_repository\": \"$IMAGE_REPOSITORY\""
fi

# Shelob authenticates callers with a short-lived token for the shelob-deployer
# service account of the cluster it runs in. Creating one needs membership of
# developers@precisely.se.
if ! TOKEN=$(kubectl --context "$KUBE_CONTEXT" create token shelob-deployer \
  -n default --audience=shelob --duration=10m); then
  echo "Could not create a shelob-deployer token in context $KUBE_CONTEXT." >&2
  echo "Are you a member of developers@precisely.se, and is the context configured?" >&2
  exit 1
fi
if [[ -z "$TOKEN" ]]; then
  echo "kubectl returned an empty shelob-deployer token for context $KUBE_CONTEXT." >&2
  echo "Are you a member of developers@precisely.se?" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
chmod 700 "$WORKDIR"
HEADERS="$WORKDIR/headers"
BODY="$WORKDIR/body"

# The token goes into a file read by curl, never onto a command line.
(
  umask 077
  cat <<EOF >"$HEADERS"
Content-Type: application/json
Authorization: Bearer $TOKEN
EOF
)
unset TOKEN

cat <<EOF >"$BODY"
{
    "deployment": "$DEPLOYMENT",
    "tag": "$TAG",
    "namespace": "$NAMESPACE"$IMAGE_REPOSITORY_FIELD
}
EOF

echo | cat "$BODY"

HAS_ERROR=""

if [[ -z "${SHELOB_TARGETS}" ]]; then
  echo "Calling shelob at shelob${SUBDOMAIN}.precisely.se"
  if ! curl --fail --http1.1 -XPOST -H @"$HEADERS" -d @"$BODY" "https://shelob${SUBDOMAIN}.precisely.se/deploy"; then
    HAS_ERROR="yes"
  fi
else
  # The token is only valid for the shelob of the cluster named by the cluster
  # argument, so every target here must belong to that cluster.
  for URL in $SHELOB_TARGETS; do
    echo "Calling shelob at $URL"
    if ! curl --fail --http1.1 -XPOST -H @"$HEADERS" -d @"$BODY" "https://${URL}/deploy"; then
      HAS_ERROR="yes"
    fi
  done
fi

if [[ -n "$HAS_ERROR" ]]; then
  exit 1
fi

echo ""
echo "Done"
exit 0
