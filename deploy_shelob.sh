#!/usr/bin/env bash

set -e

CLUSTER=${1?param missing - cluster}
DEPLOYMENT=${2?param missing - deployment}
TAG=${3?param missing - tag}
NAMESPACE=${4?param missing - namespace}
# Optional. Set to services-pr to deploy an image built from a pull request;
# empty means the release repository. Staging only.
IMAGE_REPOSITORY=${IMAGE_REPOSITORY:-}

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

SHELOB_SECRET=$(cat .shelob)

cat <<EOF >headers
Content-Type: application/json
X-Precisely-Secret: $SHELOB_SECRET
EOF

cat <<EOF >body
{
    "deployment": "$DEPLOYMENT",
    "tag": "$TAG",
    "namespace": "$NAMESPACE"$IMAGE_REPOSITORY_FIELD
}
EOF

echo | cat body

HAS_ERROR=""

if [[ -z "${SHELOB_TARGETS}" ]]; then
  SUBDOMAIN=
  if [ "$CLUSTER" = "staging" ]; then
    SUBDOMAIN=".stg"
  fi

  echo "Calling shelob at shelob${SUBDOMAIN}.precisely.se"
  if ! curl --fail --http1.1 -XPOST -H"$(cat headers)" -d @body https://shelob${SUBDOMAIN}.precisely.se/deploy; then
    HAS_ERROR="yes"
  fi
else
  for URL in $SHELOB_TARGETS; do
    echo "Calling shelob at $URL"
    if ! curl --fail --http1.1 -XPOST -H"$(cat headers)" -d @body "https://${URL}/deploy"; then
      HAS_ERROR="yes"
    fi
  done
fi

rm headers
rm body

if [[ -n "$HAS_ERROR" ]]; then
  exit 1
fi

echo ""
echo "Done"
exit 0
