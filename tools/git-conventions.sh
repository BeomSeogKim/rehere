#!/usr/bin/env bash
# Enforce the commit, branch, and pull request rules in CONTRIBUTING.md.
#   commit FILE    check a commit message file
#   range A..B     check every commit message in a range (CI)
#   branch NAME    check a branch name (pre-commit hook)
#   pr             check $PR_TITLE and $PR_BODY (CI)
set -uo pipefail

TYPES='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
HEADER="^($TYPES)(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S.*[^.\\s]\$|^Revert \".+\"\$"
BRANCH="^($TYPES)/[a-z0-9]+(-[a-z0-9]+)*\$"

errors=()
fail() { errors+=("$1"); }
report() {
  [ ${#errors[@]} -eq 0 ] && return 0
  echo "$1:" >&2
  printf '  - %s\n' "${errors[@]}" >&2
  echo "  See CONTRIBUTING.md." >&2
  errors=()
  return 1
}
guard="$(cd "$(dirname "$0")" && pwd)/check-repository.py"

check_header() {
  local header=$1
  printf '%s\n' "$header" | RE="$HEADER" perl -ne 'exit(/$ENV{RE}/ ? 0 : 1)' \
    || fail "header must be '<type>(<scope>)?: <description>' with type one of ${TYPES//|/, } and no trailing period"
  [ ${#header} -le 72 ] || fail "header is ${#header} characters; keep it within 72"
}

check_message() {
  local msg=$1 header
  header=$(printf '%s\n' "$msg" | head -n 1)
  printf '%s\n' "$msg" | python3 "$guard" --text "commit message" || fail "commit content guard failed"
  check_header "$header"
  [ -z "$(printf '%s\n' "$msg" | sed -n 2p)" ] || fail "leave the second line blank"
  printf '%s\n' "$msg" | tail -n +3 | perl -ne '$n++ if /\S/ && !/^[\w-]+: \S/; END { exit($n ? 0 : 1) }' \
    || fail "add a body that says why the change is made"
}

case "${1:-}" in
  commit)
    # Drop comment lines and everything below the scissors line, as git does on commit.
    check_message "$(sed '/^# -\{24\} >8 -\{24\}$/,$d; /^#/d' "$2")"
    report "commit message rejected"
    ;;
  range)
    status=0
    shas=$(git rev-list "$2") || exit 1
    for sha in $shas; do
      check_message "$(git log -1 --format=%B "$sha")"
      report "commit ${sha:0:12}" || status=1
    done
    exit $status
    ;;
  branch)
    printf '%s\n' "$2" | RE="$BRANCH" perl -ne 'exit(/$ENV{RE}/ ? 0 : 1)' \
      || fail "branch must be '<type>/<short-kebab-description>' with type one of ${TYPES//|/, }"
    report "branch name rejected"
    ;;
  pr)
    check_header "$PR_TITLE"
    missing=$(printf '%s' "$PR_BODY" | perl -0ne '
      s/<!--.*?-->//gs;
      for my $h (qw(Summary Why Changes Verification Checklist)) {
        if (!/^## \Q$h\E[^\n]*\n(.*?)(?=^## |\z)/ms) { print "missing section: ## $h\n"; next }
        print "empty section: ## $h\n" unless $1 =~ /\w/;
      }')
    while IFS= read -r line; do [ -n "$line" ] && fail "$line (use .github/pull_request_template.md)"; done <<< "$missing"
    checklist=(
      'I reviewed the diff for private content and English-only text.'
      'I checked that comments are necessary and current.'
      'I ran relevant checks and reported their actual results.'
    )
    for item in "${checklist[@]}"; do
      printf '%s\n' "$PR_BODY" | grep -Fqx -- "- [x] $item" || fail "complete the required review checklist"
    done
    printf '%s\n' "$PR_TITLE" "$PR_BODY" | python3 "$guard" --text "pull request" || fail "PR content guard failed"
    report "pull request rejected"
    ;;
  *)
    sed -n '2,7p' "$0" >&2
    exit 2
    ;;
esac
