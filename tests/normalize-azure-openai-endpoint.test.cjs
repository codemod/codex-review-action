'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  normalizeAzureOpenAiEndpoint,
} = require('../scripts/normalize-azure-openai-endpoint.cjs');

const RESPONSES = 'https://example.openai.azure.com/openai/v1/responses';
const COGNITIVE =
  'https://centralus.api.cognitive.microsoft.com/openai/v1/responses';

const cases = [
  {
    name: 'resource root',
    input: 'https://example.openai.azure.com',
    expected: RESPONSES,
  },
  {
    name: 'resource root with trailing slash',
    input: 'https://example.openai.azure.com/',
    expected: RESPONSES,
  },
  {
    name: 'openai/v1 prefix',
    input: 'https://example.openai.azure.com/openai/v1',
    expected: RESPONSES,
  },
  {
    name: 'openai/v1 prefix with trailing slash',
    input: 'https://example.openai.azure.com/openai/v1/',
    expected: RESPONSES,
  },
  {
    name: 'full Responses URL',
    input: RESPONSES,
    expected: RESPONSES,
  },
  {
    name: 'full Responses URL with trailing slash',
    input: `${RESPONSES}/`,
    expected: RESPONSES,
  },
  {
    name: 'cognitive services Responses URL',
    input: COGNITIVE,
    expected: COGNITIVE,
  },
  {
    name: 'whitespace around resource root',
    input: '  https://example.openai.azure.com  ',
    expected: RESPONSES,
  },
  {
    name: 'empty string',
    input: '',
    expected: '',
  },
  {
    name: 'whitespace-only',
    input: '   ',
    expected: '',
  },
];

for (const { name, input, expected } of cases) {
  test(`normalizeAzureOpenAiEndpoint: ${name}`, () => {
    assert.equal(normalizeAzureOpenAiEndpoint(input), expected);
  });
}

test('CLI writes normalized endpoint to GITHUB_OUTPUT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-endpoint-'));
  const outputFile = path.join(dir, 'github_output');
  fs.writeFileSync(outputFile, '');

  const script = path.join(
    __dirname,
    '../scripts/normalize-azure-openai-endpoint.cjs',
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
      GITHUB_OUTPUT: outputFile,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = fs.readFileSync(outputFile, 'utf8');
  assert.match(output, /^endpoint<<.+\nhttps:\/\/example\.openai\.azure\.com\/openai\/v1\/responses\n/m);
});

test('CLI fails on empty endpoint', () => {
  const script = path.join(
    __dirname,
    '../scripts/normalize-azure-openai-endpoint.cjs',
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AZURE_OPENAI_ENDPOINT: '  ',
      GITHUB_OUTPUT: path.join(os.tmpdir(), 'unused-github-output'),
    },
  });
  assert.notEqual(result.status, 0);
});

test('action and reusable workflows consume normalized endpoint output', () => {
  const roots = [
    path.join(__dirname, '../action.yml'),
    path.join(__dirname, '../.github/workflows/fork-review.yml'),
    path.join(__dirname, '../.github/workflows/review.yml'),
  ];

  for (const file of roots) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(
      text,
      /Normalize Azure OpenAI endpoint/,
      `${path.basename(file)} missing normalize step`,
    );
    assert.match(
      text,
      /steps\.normalize_azure_endpoint\.outputs\.endpoint/,
      `${path.basename(file)} must pass normalized endpoint to Codex`,
    );
    assert.doesNotMatch(
      text,
      /responses-api-endpoint:\s*\$\{\{\s*(inputs|secrets)\.azure_openai_endpoint\s*\}\}/,
      `${path.basename(file)} still passes raw endpoint to Codex`,
    );
  }
});
