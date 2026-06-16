#!/bin/sh
set -eu

ARTIFACT="${1:?Usage: notarize_artifact.sh /path/to/artifact}"

if [ "${LITTLE_SPUD_NOTARIZE:-0}" != "1" ]; then
  printf 'Skipping notarization for %s (set LITTLE_SPUD_NOTARIZE=1 to enable).\n' "${ARTIFACT}"
  exit 0
fi

if [ ! -e "${ARTIFACT}" ]; then
  printf 'Cannot notarize missing artifact: %s\n' "${ARTIFACT}" >&2
  exit 1
fi

if [ -z "${LITTLE_SPUD_NOTARY_PROFILE:-}" ]; then
  printf 'LITTLE_SPUD_NOTARIZE=1, but LITTLE_SPUD_NOTARY_PROFILE was not configured.\n' >&2
  exit 1
fi

xcrun notarytool submit "${ARTIFACT}" --wait --keychain-profile "${LITTLE_SPUD_NOTARY_PROFILE}"
