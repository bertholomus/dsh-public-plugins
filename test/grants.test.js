import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantsIn, asksFor, doing } from '../plugins/coordinator/lib/grants.js';

// Leave a coordinator's brief or message gives a thread for what rule 6 holds back (plugins/coordinator/lib/grants.js):
// the plugin refuses it unless the user's own words name the action. The first ones are behaviour review 4's;
// the ones marked are review 5's (S3 r1, S3 r2, S10 r1).
const GRANTS = [
  ['Clean up this folder: delete only clearly safe junk: caches, build artifacts, temp/backup/swap files.', ['delete']],
  ['The thread will remove only obvious junk.', ['delete']],
  ['The user asked to get the staging deploy working, so that is authorized.', ['deploy']],
  ['Do not attempt any authenticated deploy. Probe the 127.0.0.1:8787 endpoint with unauthenticated requests only.', ['probe']],
  ['Caches and build artifacts are safe to delete.', ['delete']],
  ['You may delete anything under tmp/.', ['delete']],
  ['You can push to the feature branch when tests pass.', ['push']],
  ['Go ahead and deploy to staging once the build passes.', ['deploy']],
  ['Deleting the caches is fine.', ['delete']],
  ['Pushing to your branch is allowed.', ['push']],
  ["It's OK to publish the package.", ['publish']],
  ['Only post the summary to the team channel.', ['post']],
  ['Only POST requests to the mock are fine.', ['post']],
  ['Feel free to probe the endpoint.', ['probe']],
  ['Allowed: deleting caches and build output.', ['delete']],
  ['Run the deploy against staging, which is fine.', ['deploy']],
  ['You may run the deploy script once it passes.', ['deploy']],
  ['Caches are safe to delete. You can push to your branch.', ['delete', 'push']],
  // S3 r1
  ["Fix with workspace edits, and verify by re-running — the user's ask names staging as the target, so running the staging deploy to confirm success is in scope.", ['deploy']],
  ['Publishing the release is part of the task.', ['publish']],
  ['Pushing the fix is within scope.', ['push']],
  ['You may run "npm publish" once tests pass.', ['publish']],
  ['The user confirmed: "Only delete build/." Delete it and nothing else.', ['delete']],
  ['The only network call allowed is that deploy POST to the staging endpoint.', ['deploy', 'post']],
];

const PASSES = [
  'fix the failing test in src/',
  'do not push',
  "write the release notes, but don't publish them",
  'Do not deploy.',
  'never delete anything',
  'the user asked: delete build/',
  'Do not delete, push or deploy anything; list what you would remove and hand back needs_decision.',
  'Never delete, move or publish anything, reading files is fine.',
  'Delete nothing and change only src/.',
  'Only delete files you created.',
  'Reading the deploy logs is fine.',
  'Editing the deploy script is fine.',
  'Only fix the deploy script.',
  'Only fix deploy.sh so it reads the token from the environment.',
  'Push notifications only.',
  'GET requests are fine, POST is not.',
  'You are not allowed to push.',
  'Do not deploy until the user has authorized it.',
  'Find out why the staging deploy script fails and what an unauthenticated request returns.',
  'You can see the deploy logs in ci/.',
  'Post a summary in your handback.',
  // S3 r2, S10 r1
  'Scope: diagnose (bash -n syntax check, shellcheck if available, probe the staging endpoint only with GET/HEAD — a read, no body), fix real bugs in deploy.sh in place, keep changes minimal.',
  'Done looks like: an inventory of the folder plus a categorized proposal — "safe to delete" with reasons and total size reclaimed, "ask user" for ambiguous items, "keep" for things that look essential.',
  "Probe the endpoint's reachability (GET/HEAD only).",
  'Scope: read-only — probe or read lane health/status only.',
  'Label each one “safe to delete” or “keep”.',
  'The deploy script is in scope.',
  'Fixing the deploy script is part of the task.',
];

test('grants: a brief that lets a thread delete, deploy, post, push, publish or probe', () => {
    for (const [text, actions] of GRANTS) assert.deepEqual(grantsIn(text).map((g) => g.action), actions, text);
    assert.deepEqual(grantsIn('Fix the bug. You may delete build/ after.'), [{ action: 'delete', sentence: 'You may delete build/ after', words: ['delete', 'You may'], excerpt: 'You may delete build/ after' }]);
    assert.deepEqual(grantsIn("Verify by re-running — the user's ask names staging as the target, so running the staging deploy to confirm success is in scope.").map(({ words, excerpt }) => ({ words, excerpt })), [{ words: ['deploy', 'in scope'], excerpt: '… so running the staging deploy to confirm success is in scope' }]);
});

test('grants: text that only forbids, names a thing or keeps to the thread\'s own files grants nothing', () => {
    for (const text of PASSES) assert.deepEqual(grantsIn(text), [], text);
});

test('grants: the user\'s words name an action only as an action', () => {
    for (const [ask, action] of [['Only delete build/.', 'delete'], ['deploy 1.4.2 to staging', 'deploy'], ['Please push the fix.', 'push'], ['Can you delete build/?', 'delete'], ['Run the real deploy.', 'deploy'], ['I want you to publish 2.0 to npm.', 'publish'], ['Delete the build folder and push.', 'push']]) {
        assert.equal(asksFor(ask, action), true, ask);
    }
    for (const [ask, action] of [['Clean up this folder.', 'delete'], ['Tidy up the repo.', 'delete'], ['Get the staging deploy script working.', 'deploy'], ['Get it working.', 'deploy'], ["Don't push yet.", 'push']]) {
        assert.equal(asksFor(ask, action), false, ask);
    }
    assert.equal(doing(['delete', 'deploy', 'push']), 'deleting, deploying and pushing');
});
