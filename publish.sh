#!/bin/bash
# Publish, update or take down the tour on GitHub Pages.
#
#   ./publish.sh update   rebuild the gh-pages branch from site/
#   ./publish.sh down     unpublish and make the repo private again
#   ./publish.sh status   where it is and whether it is live
#
# Pages can only serve from a branch root or /docs, so site/ is pushed as the
# root of a gh-pages branch rather than served in place.
set -eu
cd "$(dirname "$0")"
REPO=CarsonML/apartment-tour
URL=https://carsonml.github.io/apartment-tour/

case "${1:-status}" in
  update)
    git add -A && git commit -qm "site update" || echo "(nothing new to commit)"
    git push -q origin HEAD
    git push -q origin "$(git subtree split --prefix site HEAD)":refs/heads/gh-pages --force
    echo "pushed. Pages rebuilds in a minute or two: $URL"
    ;;
  down)
    gh api -X DELETE "repos/$REPO/pages" >/dev/null 2>&1 && echo "Pages disabled" || echo "Pages was not enabled"
    gh repo edit "$REPO" --visibility private --accept-visibility-change-consequences
    echo "repo is private again; $URL now 404s"
    ;;
  status)
    gh api "repos/$REPO/pages" --jq '"status: \(.status)\nurl:    \(.html_url)"' 2>/dev/null \
      || echo "Pages not enabled"
    gh repo view "$REPO" --json isPrivate --jq '"repo:   \(if .isPrivate then "private" else "PUBLIC" end)"'
    printf "live:   "; curl -s -o /dev/null -w "%{http_code}\n" "$URL"
    ;;
  *) echo "usage: $0 {update|down|status}"; exit 1 ;;
esac
