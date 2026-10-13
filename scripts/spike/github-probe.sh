#!/bin/sh
# scripts/spike/github-probe.sh <scratch-owner/repo> — spike only (deleted at the end of Task 2).
# Requires: gh authenticated with admin rights on the scratch repo; the scratch repo exists and is public.
set -eu
repo=$1
main=Tropos-AI/tropos-code
work=$(mktemp -d)
cd "$work"
say() { printf '\n== %s\n' "$*"; }

say "D1a immutability status of $main (repository endpoint)"
gh api -i "repos/$main/immutable-releases" 2>&1 | sed -n '1p;/^{/p' || true
say "D1a immutability policy of the organization"
gh api -i "orgs/${main%%/*}/settings/immutable-releases" 2>&1 | sed -n '1p;/^{/p' || true

say "D6a first release published with --latest=false: what is latest?"
echo 1 > a.txt
gh release create v0.0.1 a.txt --repo "$repo" --draft --title v0.0.1 --notes spike
gh release edit v0.0.1 --repo "$repo" --draft=false --latest=false
gh api -i "repos/$repo/releases/latest" 2>&1 | sed -n '1p;/"tag_name"/p' || true
curl -sS -o /dev/null -w 'releases/latest/download/a.txt → %{http_code}\n' -L "https://github.com/$repo/releases/latest/download/a.txt"

say "D6b --clobber gap: poll the asset while it is replaced"
gh release create channels --repo "$repo" --prerelease --latest=false --title channels --notes spike
echo 1.0.0 > latest
gh release upload channels latest --repo "$repo"
( i=0; while [ $i -lt 120 ]; do curl -sS -o /dev/null -w '%{http_code} ' -L "https://github.com/$repo/releases/download/channels/latest"; i=$((i+1)); sleep 0.25; done; echo ) > poll.txt &
sleep 2; echo 1.0.1 > latest; gh release upload channels latest --repo "$repo" --clobber; wait
tr ' ' '\n' < poll.txt | sort | uniq -c

say "D1b with immutability ON (enable it in the scratch repo's settings now, then press enter)"
read -r _
echo 2 > b.txt
gh release create v0.0.2 a.txt --repo "$repo" --draft --title v0.0.2 --notes spike
gh release edit v0.0.2 --repo "$repo" --draft=false --latest=false
echo "upload a NEW asset to the published immutable release:"; gh release upload v0.0.2 b.txt --repo "$repo" && echo ALLOWED || echo REFUSED
echo "clobber an existing asset:"; gh release upload v0.0.2 a.txt --repo "$repo" --clobber && echo ALLOWED || echo REFUSED
echo "mark as latest:"; gh release edit v0.0.2 --repo "$repo" --latest && echo ALLOWED || echo REFUSED
echo "create + clobber a prerelease created after enabling:"
gh release create channels2 --repo "$repo" --prerelease --latest=false --title channels2 --notes spike
gh release upload channels2 latest --repo "$repo" && echo "upload after publish: ALLOWED" || echo "upload after publish: REFUSED"
gh release upload channels2 latest --repo "$repo" --clobber && echo "clobber: ALLOWED" || echo "clobber: REFUSED"
gh api "repos/$repo/attestations?per_page=1" >/dev/null 2>&1 && echo "attestations endpoint reachable" || true
rm -rf "$work"
