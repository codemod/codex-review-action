'use strict';

const fs = require('node:fs');

/**
 * Normalize an Azure OpenAI endpoint for openai/codex-action.
 *
 * Accepts a shared resource root (common app secret shape) or a partial
 * `/openai/v1` URL and appends `/openai/v1/responses` when missing.
 * Full Responses URLs are returned unchanged (trailing slashes stripped).
 *
 * @param {string} endpoint
 * @returns {string}
 */
function normalizeAzureOpenAiEndpoint(endpoint) {
  const trimmed = String(endpoint ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  if (/\/openai\/v1\/responses$/i.test(trimmed)) {
    return trimmed;
  }

  if (/\/openai\/v1$/i.test(trimmed)) {
    return `${trimmed}/responses`;
  }

  return `${trimmed}/openai/v1/responses`;
}

function writeGithubOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error('GITHUB_OUTPUT is not set');
  }

  // Use a heredoc delimiter so URLs with special characters stay intact.
  const delimiter = `CURSOR_AZURE_ENDPOINT_${Date.now()}`;
  fs.appendFileSync(
    outputFile,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    'utf8',
  );
}

if (require.main === module) {
  const input = process.env.AZURE_OPENAI_ENDPOINT ?? '';
  const normalized = normalizeAzureOpenAiEndpoint(input);

  if (!normalized) {
    console.error('AZURE_OPENAI_ENDPOINT is empty after normalization');
    process.exit(1);
  }

  if (normalized !== String(input).trim().replace(/\/+$/, '')) {
    console.log(
      `Normalized Azure OpenAI endpoint to Responses URL (resource root or /openai/v1 accepted).`,
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    writeGithubOutput('endpoint', normalized);
  } else {
    process.stdout.write(`${normalized}\n`);
  }
}

module.exports = {
  normalizeAzureOpenAiEndpoint,
};
