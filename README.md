# Codex Review Action

Reusable GitHub Actions workflow for running [`openai/codex-action`](https://github.com/openai/codex-action) as a PR reviewer with:

- Azure OpenAI support
- PR summary comment upsert
- inline review comments when findings can be anchored to the diff
- same-repo-only execution when secrets are present

This repository packages the review logic as a reusable workflow, not a composite action. The flow needs multiple jobs, distinct permissions, and GitHub comment APIs, which fit `workflow_call` better than `action.yml`.

## Files

- `.github/workflows/review.yml`: reusable workflow entrypoint
- `.github/codex/review-output-schema.json`: reference copy of the structured Codex output schema

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

Use a thin caller workflow in each repository. Keep triggers in the caller repo, then delegate the review job here.

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
    uses: your-org/codex-review-action/.github/workflows/review.yml@main
    permissions:
      contents: read
      pull-requests: write
      issues: write
    with:
      pr_number: ${{ github.event_name == 'pull_request' && github.event.pull_request.number || inputs.pr_number }}
      codex_model: gpt-5.3-codex
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
    secrets:
      azure_openai_api_key: ${{ secrets.AZURE_OPENAI_API_KEY }}
      azure_openai_responses_endpoint: ${{ secrets.AZURE_OPENAI_RESPONSES_ENDPOINT }}
```

## Security model

The reusable workflow is intentionally same-repo only when secrets are present:

- it resolves the PR by API
- it checks whether `pr.head.repo.full_name == github.repository`
- if the head is from a fork, the secret-bearing review job is skipped

That means:

- automatic same-repo PR review: supported
- manual same-repo PR rerun by PR number: supported
- manual fork review with repository secrets: intentionally blocked

This is deliberate. Running fork code in a secret-bearing job is a real secret-exfiltration risk.

## Inputs

- `pr_number`: required PR number to review
- `codex_model`: required Azure deployment name
- `working_directory`: checkout subdirectory to run from
- `node_version`: Node.js version for `actions/setup-node`
- `pnpm_version`: pnpm version for `pnpm/action-setup`
- `install_command`: dependency installation command
- `codex_effort`: Codex effort level
- `sandbox`: Codex sandbox mode
- `review_focus`: extra review criteria inserted into the prompt
- `extra_prompt`: extra prompt text appended after the standard review instructions

## Secrets

- `azure_openai_api_key`
- `azure_openai_responses_endpoint`

## Notes

- The workflow expects `pnpm` by default, but the caller can override `install_command`, `node_version`, `pnpm_version`, and `working_directory`.
- The reusable workflow embeds its output schema inline so callers do not need to copy schema files into their own repositories.
- The reusable workflow emits inline comments only when a finding has a valid `path` and a line that GitHub can anchor on the right side of the PR diff.
- If Codex returns non-JSON output unexpectedly, the workflow falls back to treating that output as the summary comment body.
