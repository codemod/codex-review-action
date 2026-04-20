# Codex Review Action

Composite GitHub Action for running [`openai/codex-action`](https://github.com/openai/codex-action) as a PR reviewer with:

- Azure OpenAI support
- PR summary comment upsert
- inline review comments when findings can be anchored to the diff
- reusable central review logic for multiple repositories

## Files

- `action.yml`: composite action entrypoint
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
      - uses: your-org/codex-review-action@main
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
          codex_effort: medium
          sandbox: workspace-write
          review_focus: |
            Focus on:
            - correctness bugs
            - behavioral regressions
            - missing tests or missing edge-case coverage
            - security issues
          extra_prompt: |
            Follow any repository-specific review guidance files when present.
```

## Security model

The shared action is meant to run only in caller jobs that already enforce same-repo execution when secrets are present.

Recommended caller guard:

- check whether `pr.head.repo.full_name == github.repository`
- skip secret-bearing review jobs for fork PRs

That means:

- automatic same-repo PR review: supported
- manual same-repo PR rerun by PR number: supported
- manual fork review with repository secrets: intentionally blocked

This is deliberate. Running fork code in a secret-bearing job is a real secret-exfiltration risk.

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
- `sandbox`: Codex sandbox mode
- `review_focus`: extra review criteria inserted into the prompt
- `extra_prompt`: extra prompt text appended after the standard review instructions

## Secrets

## Notes

- The action expects `pnpm` by default, but the caller can override `install_command`, `node_version`, `pnpm_version`, and `working_directory`.
- The action embeds its output schema inline so callers do not need to copy schema files into their own repositories.
- The action emits inline comments only when a finding has a valid `path` and a line that GitHub can anchor on the right side of the PR diff.
- If Codex returns non-JSON output unexpectedly, the action falls back to treating that output as the summary comment body.
