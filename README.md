# Codex Review Action

Composite GitHub Action for running [`openai/codex-action`](https://github.com/openai/codex-action) as a PR reviewer with:

- Azure OpenAI support
- PR summary comment upsert
- inline review comments when findings can be anchored to the diff
- `/codex-review` PR comment trigger for repository owners and organization members
- maintainer-triggered, patch-only reviews for pull requests from forks
- reusable central review logic for multiple repositories

## Files

- `action.yml`: composite action entrypoint
- `.github/workflows/fork-review.yml`: fork-safe reusable workflow with separate analysis and posting jobs
- `examples/codex-review-command.yml`: standard slash-command caller workflow
- `examples/codex-review-command-arc-codemods.yml`: `arc-codemods` slash-command workflow with repository-specific review settings
- `.github/codex/review-output-schema.json`: reference copy of the structured Codex output schema
- `.github/workflows/review.yml`: legacy reusable workflow entrypoint

## Required caller configuration

In the calling repository, configure:

- Secret: `AZURE_OPENAI_API_KEY`
- Secret: `AZURE_OPENAI_RESPONSES_ENDPOINT`
- A model/deployment name to pass as `codex_model`

For Azure, the endpoint must be the full Responses API URL, for example:

```text
https://centralus.api.cognitive.microsoft.com/openai/v1/responses
```

## Recommended caller workflow

Use a thin caller workflow in each repository. Keep triggers and permissions in the caller repo, then delegate the review steps here.

```yaml
name: Codex PR Review

on:
  pull_request:
    branches:
      - main
    types:
      - opened
      - synchronize
      - reopened
      - ready_for_review
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to review manually
        required: true
        type: number

jobs:
  codex-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    if: ${{ !github.event.pull_request.draft && github.event.pull_request.head.repo.full_name == github.repository }}
    steps:
      - uses: codemod/codex-review-action@main
        with:
          github_token: ${{ github.token }}
          pr_number: ${{ github.event.pull_request.number }}
          codex_model: ${{ vars.AZURE_OPENAI_CODEX_MODEL }}
          azure_openai_api_key: ${{ secrets.AZURE_OPENAI_API_KEY }}
          azure_openai_responses_endpoint: ${{ secrets.AZURE_OPENAI_RESPONSES_ENDPOINT }}
          node_version: "24"
          pnpm_version: "10.19.0"
          install_command: pnpm install --frozen-lockfile
          working_directory: .
          codex_effort: high
          permission_profile: ":workspace"
          review_focus: |
            Focus on:
            - correctness bugs
            - behavioral regressions
            - missing tests or missing edge-case coverage
            - security issues
          extra_prompt: |
            Follow any repository-specific review guidance files when present.
```

## `/codex-review` slash command

GitHub event triggers belong to the consumer repository, so a composite action cannot register a slash command by itself. The pin-sync workflow described below automatically adds `.github/workflows/codex-review-command.yml` to the three managed consumer repositories. For another consumer repository, copy [`examples/codex-review-command.yml`](examples/codex-review-command.yml) there manually.

Once that workflow is present on the consumer repository's default branch, a repository owner or organization member can add this exact PR comment:

```text
/codex-review
```

The workflow intentionally:

- listens only for newly created PR comments
- accepts only the exact `/codex-review` comment
- accepts only GitHub `OWNER` and `MEMBER` author associations
- refuses draft PRs
- routes same-repository PRs through the existing full-checkout review
- routes fork PRs through the patch-only reusable workflow
- allows inline review comments for command-triggered reviews
- serializes reviews for the same PR so repeated commands do not overlap

The caller-level `if` avoids starting runners for unrelated comments. The composite action and fork reusable workflow repeat their applicable authorization and trust checks as defense in depth.

Pin `codemod/codex-review-action` to a full commit SHA in production rather than leaving the example's `@main` reference in place.

## Security model

The composite action remains restricted to trusted same-repository pull requests whenever it checks out code, installs dependencies, and runs Codex with repository secrets.

The command workflow resolves the PR before selecting one of two paths:

- Same-repository PRs use the composite action and retain dependency installation plus full-checkout inspection.
- Fork PRs use `.github/workflows/fork-review.yml` only after an `OWNER` or `MEMBER` posts the exact `/codex-review` command.

The fork workflow deliberately does not execute fork-controlled code:

- it checks out the trusted base commit, never the fork head
- it downloads the pull request diff through the GitHub API and stores it as read-only review data
- it does not install dependencies, run builds or tests, load fork-controlled Codex configuration, or execute repository scripts
- it runs Codex with `permission-profile: ":read-only"` and `safety-strategy: "drop-sudo"`
- Codex is the final step in the Azure-secret-bearing job
- a fresh job with no Azure credential and no checkout validates the structured result and posts the review

Normal `pull_request` CI for forks can continue installing dependencies and running tests under GitHub's secure defaults, which withhold repository secrets and supply a read-only token. Do not pass those jobs secrets or a write-capable token, and do not reuse their runner or executable artifacts in the fork review workflow.

That means:

- automatic same-repository PR review: supported
- manual same-repository review through `/codex-review`: supported
- manual fork review through `/codex-review`: supported through the patch-only path
- automatic fork review: intentionally not configured

## Inputs

- `github_token`: required token for GitHub API calls, checkout, and comment posting
- `pr_number`: required PR number to review
- `codex_model`: required Azure deployment name
- `azure_openai_api_key`: required Azure OpenAI API key
- `azure_openai_responses_endpoint`: required Azure OpenAI Responses API endpoint
- `working_directory`: checkout subdirectory to run from
- `node_version`: Node.js version for `actions/setup-node`
- `pnpm_version`: pnpm version for `pnpm/action-setup`
- `install_command`: dependency installation command
- `codex_effort`: Codex effort level
- `sandbox`: legacy Codex sandbox mode, used only when `permission_profile` is empty
- `permission_profile`: Codex permission profile, default `:workspace`
- `codex_version`: optional Codex CLI version passed through to `openai/codex-action`
- `review_focus`: extra review criteria inserted into the prompt
- `extra_prompt`: extra prompt text appended after the standard review instructions

## Secrets

## Notes

- The action expects `pnpm` by default, but the caller can override `install_command`, `node_version`, `pnpm_version`, and `working_directory`.
- Fork reviews ignore dependency-installation inputs because no fork-controlled code is executed in the secret-bearing workflow.
- The action generates its output schema at runtime so callers do not need to copy schema files into their own repositories.
- The action precomputes the PR diff stat, changed files, and a bounded patch snapshot before invoking Codex so the model has review context immediately and can still inspect the checkout for deeper analysis.
- If Codex returns a meta-response claiming it cannot inspect the PR diff, the action fails closed instead of posting that response as a PR review.
- The action emits inline comments in a single batched PR review when findings have a valid `path` and a line that GitHub can anchor on the right side of the PR diff.
- The action posts inline comments for `/codex-review` command runs, initial PR review events (`opened`, `reopened`, `ready_for_review`), and manual `workflow_dispatch` reruns; `synchronize` reruns update only the summary comment to avoid repeated inline comment spam.
- The action preserves existing inline comments across reruns so review threads can be resolved manually; only the summary comment is updated in place after the initial inline review.
- If Codex returns non-JSON output unexpectedly, the action falls back to treating that output as the summary comment body.
- The OpenAI action is pinned before the runner DNS regression tracked in [`openai/codex-action#160`](https://github.com/openai/codex-action/issues/160), and transient GitHub API failures during review posting are retried up to three times.

## Pin Sync Workflow

This repository includes `.github/workflows/sync-action-pins.yml` to keep the Codex review integration updated in downstream repositories:

- `codemod/arc-codemods`
- `codemod/codemod`
- `codemod/codemod-app`

It runs on pushes to `main` and on manual dispatch. For each target repository, it:

- updates the `codemod/codex-review-action@<sha>` reference in `.github/workflows/codex-pr-review.yml` when that workflow uses the central action
- adds or updates `.github/workflows/codex-review-command.yml` from the appropriate template and pins both the composite action and fork reusable workflow to the same SHA
- opens or updates one draft PR on branch `codex/update-codex-review-action-<short-sha>` containing both changes

Required repository secrets for this workflow:

- `ACTION_SYNC_APP_ID`
- `ACTION_SYNC_APP_PRIVATE_KEY`

Those secrets should belong to a GitHub App installation that has `contents: write`, `pull_requests: write`, and `workflows: write` access to the three target repositories.
