const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function script(file, stepName, indent) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const step = source.split(`- name: ${stepName}\n`)[1];
  assert(step, `Missing ${stepName}`);
  const lines = step.split('script: |\n')[1].split('\n');
  const body = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return new AsyncFunction('context', 'github', 'core', 'process', body.join('\n'));
}
const templates = ['examples/codex-review-command.yml', 'examples/codex-review-command-arc-codemods.yml'];
const targets = [
  ...templates.map(file => ({ file, step: 'Authorize command', indent: 12 })),
  { file: 'action.yml', step: 'Resolve pull request context', indent: 10 },
  { file: '.github/workflows/fork-review.yml', step: 'Authorize fork review command', indent: 12 },
];
for (const target of targets) {
  const run = script(target.file, target.step, target.indent);
  async function check({ permission = 'write', association = 'COLLABORATOR', lookupError, missingAuthor = false } = {}) {
    const errors = [], lookups = [], outputs = {};
    let pullReads = 0;
    const context = {
      eventName: 'issue_comment', actor: 'admin-rerunning-workflow',
      repo: { owner: 'codemod', repo: 'example' },
      payload: { issue: { number: 12, pull_request: {} }, comment: {
        id: 123, body: '/codex-review', author_association: association,
        user: missingAuthor ? undefined : { login: 'original-comment-author' },
      } },
    };
    const github = { rest: {
      repos: { getCollaboratorPermissionLevel: async args => {
        lookups.push(args);
        if (lookupError) throw new Error('permission lookup unavailable');
        return { data: { permission, role_name: 'custom-role' } };
      } },
      pulls: { get: async () => {
        pullReads++;
        return { data: {
          number: 12, draft: false,
          base: { sha: 'a'.repeat(40), ref: 'main', repo: { full_name: 'codemod/example' } },
          head: { sha: 'b'.repeat(40), repo: { full_name: target.file.includes('fork-review') ? 'fork/example' : 'codemod/example' } },
        } };
      } },
    } };
    await run(context, github, {
      setFailed: msg => errors.push(msg), setOutput: (key, value) => { outputs[key] = value; },
    }, { env: { PR_NUMBER: '12' } });
    if (!missingAuthor) assert.deepEqual(lookups, [{ owner: 'codemod', repo: 'example', username: 'original-comment-author' }]);
    else assert.equal(lookups.length, 0);
    return { errors, outputs, pullReads };
  }
  for (const permission of ['write', 'maintain', 'admin']) {
    test(`${target.file}: outside collaborator with ${permission} is authorized`, async () => {
      assert.deepEqual((await check({ permission })).errors, []);
    });
  }
  for (const permission of ['read', 'triage', 'none', 'unexpected', null]) {
    test(`${target.file}: even MEMBER with ${permission} is rejected before PR access`, async () => {
      const result = await check({ permission, association: 'MEMBER' });
      assert.match(result.errors[0], /requires write/);
      assert.equal(result.pullReads, 0);
      assert.deepEqual(result.outputs, {});
    });
  }
  test(`${target.file}: unknown association does not override verified write access`, async () => {
    assert.deepEqual((await check({ association: 'NONE' })).errors, []);
  });
  for (const options of [{ lookupError: true }, { missingAuthor: true }]) {
    test(`${target.file}: authorization fails closed for ${JSON.stringify(options)}`, async () => {
      const result = await check(options);
      assert.equal(result.errors.length, 1);
      assert.equal(result.pullReads, 0);
      assert.deepEqual(result.outputs, {});
    });
  }
}
for (const file of templates) {
  const acknowledge = script(file, 'Acknowledge command', 12);
  test(`${file}: acknowledges original command; API rejection remains non-fatal`, async () => {
    const warnings = [], calls = [];
    const context = { repo: { owner: 'codemod', repo: 'example' }, payload: { comment: { id: 123 } } };
    const github = { rest: { reactions: { createForIssueComment: async args => { calls.push(args); } } } };
    await acknowledge(context, github, { warning: msg => warnings.push(msg) });
    assert.deepEqual(calls, [{ owner: 'codemod', repo: 'example', comment_id: 123, content: 'eyes' }]);
    github.rest.reactions.createForIssueComment = async () => { throw new Error('403'); };
    await acknowledge(context, github, { warning: msg => warnings.push(msg) });
    assert.equal(warnings.length, 1);
  });
}
