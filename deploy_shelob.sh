#!/usr/bin/env bash

set -e

CLUSTER=${1?param missing - cluster}
DEPLOYMENT=${2?param missing - deployment}
TAG=${3?param missing - tag}
NAMESPACE=${4?param missing - namespace}

SHELOB_SECRET=$(cat .shelob)

cat <<EOF >headers
Content-Type: application/json
X-Precisely-Secret: $SHELOB_SECRET
EOF

cat <<EOF >body
{
    "deployment": "$DEPLOYMENT",
    "tag": "$TAG",
    "namespace": "$NAMESPACE"
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
