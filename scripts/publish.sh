#!/bin/sh
# Builds, signs and publishes a release on GitHub, which the apps then offer as an update:
#   scripts/publish.sh android 3.3.0 55 notes.md   (tag v3.3.0: the APK and SHA256SUMS)
#   scripts/publish.sh mac 0.2.0 notes.md          (tag mac-v0.2.0: zips, dmgs and SHA256SUMS)
# Plain versions only (no -beta): a normal release, marked latest. The apps update only to
# releases whose tag is v<x.y.z> or mac-v<x.y.z>, not pre-releases, and check each download
# against SHA256SUMS. Android needs .signing/ (see release.sh); the Mac needs DD_SIGNING_PEM and
# RCODESIGN (see macos/README.md). Run on the commit to release; it tags and pushes it.
set -eu
cd "$(dirname "$0")/.."
platform=${1:-}
case "$platform" in
android)
    [ $# -eq 4 ] || { echo 'Usage: scripts/publish.sh android <version> <versionCode> <notes.md>' >&2; exit 1; }
    version=$2 code=$3 notes=$4 tag=v$2 ;;
mac)
    [ $# -eq 3 ] || { echo 'Usage: scripts/publish.sh mac <version> <notes.md>' >&2; exit 1; }
    version=$2 notes=$3 tag=mac-v$2 ;;
*)
    echo 'Usage: scripts/publish.sh android|mac …' >&2; exit 1 ;;
esac
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Plain versions only (x.y.z), not $version" >&2; exit 1; }
[ -f "$notes" ] || { echo "No release notes at $notes" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Commit everything first: the release is built from HEAD.' >&2; exit 1; }

if [ "$platform" = android ]; then
    scripts/release.sh "$version" "$code"
    title="Dictate & Delegate $version"
    files="dist/Dictate-and-Delegate-$version.apk dist/SHA256SUMS"
else
    [ "$(node -p "require('./macos/package.json').version")" = "$version" ] || { echo "macos/package.json isn't $version" >&2; exit 1; }
    out=dist/mac-$version
    mkdir -p "$out"
    (cd macos && node scripts/package.js --arch arm64,x64 --dmg --out "../$out")
    (cd "$out" && shasum -a 256 Dictate-and-Delegate-"$version"-mac-*.zip Dictate-and-Delegate-"$version"-mac-*.dmg > SHA256SUMS)
    title="Dictate & Delegate for macOS $version"
    files="$out/Dictate-and-Delegate-$version-mac-arm64.zip $out/Dictate-and-Delegate-$version-mac-x64.zip $out/Dictate-and-Delegate-$version-mac-arm64.dmg $out/Dictate-and-Delegate-$version-mac-x64.dmg $out/SHA256SUMS"
fi

git tag "$tag"
git push origin HEAD "$tag"
# shellcheck disable=SC2086
gh release create "$tag" --verify-tag --latest --title "$title" --notes-file "$notes" $files
