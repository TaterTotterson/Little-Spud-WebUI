#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
REPO_ROOT="$(cd "${PROJECT_DIR}/../.." && pwd -P)"
APP_NAME="Little Spud"
EXECUTABLE_NAME="LittleSpud"
APP_DIR="${PROJECT_DIR}/build/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
CODESIGN_IDENTITY="${LITTLE_SPUD_CODESIGN_IDENTITY:--}"

if [ ! -f "${REPO_ROOT}/index.html" ]; then
  printf 'Missing Little Spud WebUI at %s\n' "${REPO_ROOT}" >&2
  exit 1
fi

swift build -c release --package-path "${PROJECT_DIR}"
BIN_DIR="$(swift build -c release --package-path "${PROJECT_DIR}" --show-bin-path)"

"${SCRIPT_DIR}/generate_app_icon.sh"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

cp "${BIN_DIR}/${EXECUTABLE_NAME}" "${MACOS_DIR}/${EXECUTABLE_NAME}"
cp "${PROJECT_DIR}/Resources/Info.plist" "${CONTENTS_DIR}/Info.plist"
cp "${PROJECT_DIR}/Resources/LittleSpudIcon.icns" "${RESOURCES_DIR}/LittleSpudIcon.icns"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.DS_Store' \
  --exclude='node_modules/' \
  --exclude='macos/' \
  "${REPO_ROOT}/" "${RESOURCES_DIR}/WebUI/"

chmod +x "${MACOS_DIR}/${EXECUTABLE_NAME}"

find "${APP_DIR}" -exec xattr -c {} +
codesign --force --deep --sign "${CODESIGN_IDENTITY}" "${APP_DIR}"
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

printf 'Built %s\n' "${APP_DIR}"
