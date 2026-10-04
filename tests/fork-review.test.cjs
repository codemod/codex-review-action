const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Execute the actual trusted workflow scripts with mocked GitHub responses.
// No model requests, credentials, or GitHub writes are used by these tests.
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/fork-review.yml'), 'utf8');
function stepBlock(name, key, indent) {
  const step = workflow.split(`- name: ${name}\n`)[1];
  assert(step, `Missing step ${name}`);
  const lines = step.split(`${key}: |\n`)[1].split('\n');
  const result = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
    result.push(line.slice(indent));
  }
  return result.join('\n');
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function script(name) {
  return new AsyncFunction('require', 'process', 'context', 'github', 'core', stepBlock(name, 'script', 12));
}
const authorize = script('Authorize fork review command');
const prepare = script('Prepare fork diff as untrusted review data');
const post = script('Validate and post Codex fork review');
const base = 'a'.repeat(40), head = 'b'.repeat(40), otherHead = 'c'.repeat(40);
const pr = {
  number: 2403, draft: false, title: 'Example', body: 'Example body',
  base: { sha: base, repo: { full_name: 'codemod/codemod' } },
  head: { sha: head, repo: { full_name: 'contributor/codemod' } },
};
const context = {
  eventName: 'issue_comment', repo: { owner: 'codemod', repo: 'codemod' },
  payload: { issue: { number: 2403, pull_request: {} }, comment: { body: '/codex-review', author_association: 'MEMBER' } },
};
const file = { filename: 'src/example.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' };
function state() {
  const result = { errors: [], outputs: {} };
  result.core = { setFailed: message => result.errors.push(message), setOutput: (key, value) => { result.outputs[key] = value; } };
  return result;
}
function assertComparison(args) {
  assert.equal(args.basehead, `${base}...${head}`);
  assert.equal(args.owner, 'codemod');
  assert.equal(args.repo, 'codemod');
}

for (const association of ['OWNER', 'MEMBER', 'NONE', 'CONTRIBUTOR', 'COLLABORATOR']) {
  test(`authorization: ${association}`, async () => {
    const input = structuredClone(context);
    input.payload.comment.author_association = association;
    const result = state();
    await authorize(require, { env: { PR_NUMBER: '2403' } }, input, { rest: { pulls: { get: async () => ({ data: pr }) } } }, result.core);
    assert.equal(result.errors.length > 0, !['OWNER', 'MEMBER'].includes(association));
  });
}

test('a push/reset during collection cannot change the reviewed diff or file list', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = state();
  let liveHead = head;
  const github = {
    rest: {
      pulls: { get: async () => { liveHead = otherHead; return { data: structuredClone(pr) }; } },
      repos: { compareCommitsWithBasehead: async args => {
        assert.equal(liveHead, otherHead);
        assertComparison(args);
        assert.equal(args.page, 1);
        return { data: { files: [file] } };
      } },
    },
    request: async (route, args) => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/compare/{basehead}');
      assertComparison(args);
      liveHead = head;
      return { data: 'diff for authorized head' };
    },
  };
  await prepare(require, { env: { PR_NUMBER: '2403', EXPECTED_BASE_SHA: base, EXPECTED_HEAD_SHA: head, REVIEW_ARTIFACT_DIR: dir } }, context, github, result.core);
  assert.deepEqual(result.errors, []);
  assert.equal(liveHead, head);
  const prompt = fs.readFileSync(result.outputs.prompt_file, 'utf8');
  assert(prompt.includes(`Head SHA: ${head}`));
  assert(prompt.includes(file.filename));
  assert(prompt.includes('diff for authorized head'));
  assert.equal(fs.readFileSync(path.join(dir, 'pull-request.diff'), 'utf8'), 'diff for authorized head');
});

for (const files of [undefined, Array(300).fill(file)]) {
  test(`collection rejects ${files ? 'potentially truncated' : 'missing'} comparison files`, async () => {
    const result = state();
    await prepare(require, { env: { PR_NUMBER: '2403', EXPECTED_BASE_SHA: base, EXPECTED_HEAD_SHA: head } }, context,
      { rest: { pulls: { get: async () => ({ data: pr }) }, repos: { compareCommitsWithBasehead: async () => ({ data: { files } }) } } }, result.core);
    assert.match(result.errors[0], /file list/);
    assert.deepEqual(result.outputs, {});
  });
}

async function runPost(review, options = {}) {
  const result = state(), calls = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: options.currentPr || pr }),
        listReviewComments: () => {},
        createReview: async args => calls.push(['review', args]),
      },
      repos: { compareCommitsWithBasehead: async args => {
        assertComparison(args);
        return { data: { files: options.files || [file] } };
      } },
      issues: {
        listComments: () => {},
        createComment: async args => calls.push(['summary', args]),
        updateComment: async args => calls.push(['update', args]),
      },
    },
    paginate: async () => [],
  };
  await post(require, { env: { PR_NUMBER: '2403', PR_HEAD_SHA: head, PR_BASE_SHA: base, CODEX_FINAL_MESSAGE: typeof review === 'string' ? review : JSON.stringify(review) } }, context, github, result.core);
  return { ...result, calls };
}

for (const message of [
  'Unable to inspect the PR diff; no review was performed.',
  'Couldn’t inspect the changed files.', 'Could not inspect the diff.', 'Cannot inspect the diff.',
  "I don't have the actual changed files.", 'I do not have the actual changed files.',
  'I need to inspect the repository diff.', 'Please provide the diff output.',
]) {
  test(`reject non-review: ${message}`, async () => {
    const result = await runPost({ summary: message, findings: [] });
    assert.match(result.errors[0], /non-review/);
    assert.deepEqual(result.calls, []);
  });
}

test('reject a missing-diff claim hidden in an unanchored finding', async () => {
  const result = await runPost({ summary: 'Review result', findings: [{ title: 'Blocked', body: 'Unable to inspect the diff.', path: '', line: 0 }] });
  assert.match(result.errors[0], /non-review/);
  assert.deepEqual(result.calls, []);
});

test('post a legitimate clean review', async () => {
  const result = await runPost({ summary: 'No material findings.', findings: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0][0], 'summary');
});

test('post an anchored finding even when it describes inspection limitations', async () => {
  const result = await runPost({ summary: 'One bug found.', findings: [{ title: 'Missing access check', body: 'The user is unable to inspect their own record.', path: file.filename, line: 1, severity: 'high' }] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.calls[0][0], 'review');
  assert.equal(result.calls[0][1].commit_id, head);
  assert.equal(result.calls[0][1].event, 'COMMENT');
  assert.equal(result.calls[0][1].comments[0].path, file.filename);
});

for (const side of ['base', 'head']) {
  test(`reject a changed ${side} before posting`, async () => {
    const currentPr = structuredClone(pr);
    currentPr[side].sha = otherHead;
    const result = await runPost({ summary: 'No material findings.', findings: [] }, { currentPr });
    assert.match(result.errors[0], /changed during review/);
    assert.deepEqual(result.calls, []);
  });
}

test('reject potentially truncated inline location data', async () => {
  const result = await runPost({ summary: 'No material findings.', findings: [] }, { files: Array(300).fill(file) });
  assert.match(result.errors[0], /file list/);
  assert.deepEqual(result.calls, []);
});

for (const raw of ['not JSON', 'null', '{}', JSON.stringify({ summary: 1, findings: [] }), 'x'.repeat(250001)]) {
  test(`reject malformed or oversized output (${raw.length} characters)`, async () => {
    const result = await runPost(raw);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.calls, []);
  });
}

test('untrusted output cannot redirect posting or execute shell-like text', async () => {
  const result = await runPost({ summary: '$(touch marker) `command`', repo: 'other', pull_number: 1, findings: [{ title: 'Bad path', body: 'Example', path: '../../outside', line: 1, severity: 'high' }] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.calls.length, 1);
  const [type, args] = result.calls[0];
  assert.equal(type, 'summary');
  assert.equal(args.owner, 'codemod');
  assert.equal(args.repo, 'codemod');
  assert.equal(args.issue_number, 2403);
  assert(args.body.includes('$(touch marker) `command`'));
});

test('runtime version validation accepts only exact stable versions', () => {
  const validation = stepBlock('Validate Azure OpenAI configuration', 'run', 10);
  for (const version of ['0.160.0', '1.2.3', '', 'latest', '^0.160.0', '0.160.0 || touch marker']) {
    const result = spawnSync('bash', ['-c', validation], { encoding: 'utf8', env: {
      PATH: process.env.PATH, CODEX_VERSION: version,
      AZURE_OPENAI_API_KEY: 'fake', AZURE_OPENAI_RESPONSES_ENDPOINT: 'fake', AZURE_OPENAI_CODEX_MODEL: 'fake',
    } });
    assert.equal(result.status === 0, ['0.160.0', '1.2.3'].includes(version), version);
  }
  assert.match(workflow, /codex_version:[\s\S]*?default: "0\.160\.0"/);
});
