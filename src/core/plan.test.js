import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlanFromActivity, syncActivitiesToPlan, extractHeadlessPlan, formatConfigValue, formatPlanStatus, formatPlanStep } from './plan.js';

test('ensurePlanFromActivity: creates multi-step plan from activity.plan.steps', () => {
  const session = { headlessPlan: null };
  const activity = {
    key: 'prod:job-1',
    label: 'Pipeline',
    plan: { steps: [{ id: 'build', label: 'Build' }, { id: 'polish', label: 'Polish' }] },
    progress: {},
  };
  ensurePlanFromActivity(session, activity);
  assert.equal(session.headlessPlan.length, 2);
  assert.equal(session.headlessPlan[0].step, 1);
  assert.equal(session.headlessPlan[0].id, 'build');
  assert.equal(session.headlessPlan[0].description, 'Build');
  assert.equal(session.headlessPlan[0].status, 'pending');
  assert.equal(session.headlessPlan[0]._activityKey, 'prod:job-1');
  assert.equal(session.headlessPlan[1].id, 'polish');
});

test('ensurePlanFromActivity: creates mono-step plan when no plan.steps', () => {
  const session = { headlessPlan: null };
  const activity = { key: 'prod:job-1', label: 'Build EAE', plan: null, progress: {} };
  ensurePlanFromActivity(session, activity);
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.headlessPlan[0].description, 'Build EAE');
  assert.equal(session.headlessPlan[0]._activityKey, 'prod:job-1');
});

test('ensurePlanFromActivity: does not overwrite plan for same activity key', () => {
  const existing = [{ step: 1, description: 'Existing', status: 'running', _activityKey: 'prod:job-1' }];
  const session = { headlessPlan: existing };
  const activity = { key: 'prod:job-1', label: 'Updated', plan: null, progress: {} };
  ensurePlanFromActivity(session, activity);
  assert.strictEqual(session.headlessPlan, existing);
});

test('ensurePlanFromActivity: replaces plan for different activity key', () => {
  const existing = [{ step: 1, description: 'Old', status: 'done', _activityKey: 'prod:job-1' }];
  const session = { headlessPlan: existing };
  const activity = { key: 'prod:job-2', label: 'New Job', plan: null, progress: {} };
  ensurePlanFromActivity(session, activity);
  assert.notStrictEqual(session.headlessPlan, existing);
  assert.equal(session.headlessPlan.length, 1);
  assert.equal(session.headlessPlan[0].description, 'New Job');
  assert.equal(session.headlessPlan[0]._activityKey, 'prod:job-2');
});

test('ensurePlanFromActivity: replaces null-key minimal plan for real activity', () => {
  const minimal = [{ step: 1, description: 'cme.cme_export_run', status: 'running', _activityKey: null }];
  const session = { headlessPlan: minimal };
  const activity = { key: 'cme:export-1', label: 'CME Export', plan: null, progress: {} };
  ensurePlanFromActivity(session, activity);
  assert.notStrictEqual(session.headlessPlan, minimal);
  assert.equal(session.headlessPlan[0].description, 'CME Export');
  assert.equal(session.headlessPlan[0]._activityKey, 'cme:export-1');
});

test('ensurePlanFromActivity: no-op on null activity', () => {
  const session = { headlessPlan: null };
  ensurePlanFromActivity(session, null);
  assert.equal(session.headlessPlan, null);
});

test('syncActivitiesToPlan: stepId sets correct step running, preceding pending→done', () => {
  const plan = [
    { step: 1, id: 'extract', description: 'Extract', status: 'pending' },
    { step: 2, id: 'build', description: 'Build', status: 'pending' },
    { step: 3, id: 'polish', description: 'Polish', status: 'pending' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:1', label: 'Build', status: 'running', terminal: false,
    progress: { stepId: 'build' },
  }]);
  assert.equal(plan[0].status, 'done');
  assert.equal(plan[1].status, 'running');
  assert.equal(plan[2].status, 'pending');
});

test('syncActivitiesToPlan: stepIndex sets preceding steps done', () => {
  const plan = [
    { step: 1, description: 'Step 1', status: 'pending' },
    { step: 2, description: 'Step 2', status: 'pending' },
    { step: 3, description: 'Step 3', status: 'pending' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:1', label: 'Step 3', status: 'running', terminal: false,
    progress: { stepIndex: 3 },
  }]);
  assert.equal(plan[0].status, 'done');
  assert.equal(plan[1].status, 'done');
  assert.equal(plan[2].status, 'running');
});

test('syncActivitiesToPlan: terminal success marks all activity steps done', () => {
  const plan = [
    { step: 1, id: 'build', description: 'Build', status: 'running', _activityKey: 'prod:1' },
    { step: 2, id: 'polish', description: 'Polish', status: 'pending', _activityKey: 'prod:1' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:1', label: 'Pipeline', status: 'done', terminal: true,
    progress: { stepId: 'build' },
  }]);
  assert.equal(plan[0].status, 'done');
  assert.equal(plan[1].status, 'done');
});

test('syncActivitiesToPlan: terminal failed marks matched step failed, prior steps preserved', () => {
  const plan = [
    { step: 1, id: 'extract', description: 'Extract', status: 'done' },
    { step: 2, id: 'build', description: 'Build', status: 'running' },
    { step: 3, id: 'polish', description: 'Polish', status: 'pending' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:1', label: 'Build', status: 'failed', terminal: true,
    progress: { stepId: 'build' },
  }]);
  assert.equal(plan[0].status, 'done');
  assert.equal(plan[1].status, 'failed');
  assert.equal(plan[2].status, 'pending');
});

test('syncActivitiesToPlan: failed step not repassed to done', () => {
  const plan = [
    { step: 1, id: 'build', description: 'Build', status: 'failed' },
    { step: 2, id: 'polish', description: 'Polish', status: 'pending' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:1', label: 'Polish', status: 'done', terminal: true,
    progress: { stepId: 'polish' },
  }]);
  assert.equal(plan[0].status, 'failed');
  assert.equal(plan[1].status, 'done');
});

test('syncActivitiesToPlan: legacy text matching still works for old agents', () => {
  const plan = [
    { step: 1, description: 'ingest production content', status: 'pending' },
    { step: 2, description: 'build output', status: 'pending' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:1', label: 'Production build', status: 'running',
    source: 'production', kind: 'build', terminal: false, progress: {},
  }]);
  assert.equal(plan[0].status, 'done');
  assert.equal(plan[1].status, 'running');
});

test('syncActivitiesToPlan: _activityKey mismatch prevents structured match', () => {
  const plan = [
    { step: 1, id: 'build', description: 'Build', status: 'pending', _activityKey: 'prod:job-A' },
  ];
  syncActivitiesToPlan(plan, [{
    key: 'prod:job-B', label: 'Build', status: 'running', terminal: false,
    progress: { stepId: 'build' },
  }]);
  assert.equal(plan[0].status, 'pending');
});

test('extractHeadlessPlan: parses numbered list from text (legacy)', () => {
  const text = '1. CME export\n2. Build pipeline\n3. Send report';
  const plan = extractHeadlessPlan(text);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].description, 'CME export');
  assert.equal(plan[1].step, 2);
});

test('formatPlanStep renders structured steps without object interpolation', () => {
  assert.equal(formatPlanStep('Build'), 'Build');
  assert.equal(formatPlanStep({ description: 'Build deliverable', label: 'Build' }), 'Build deliverable');
  assert.equal(formatPlanStep({ label: 'Build' }), 'Build');
  assert.equal(formatPlanStep({ id: 'build-doc' }), 'build-doc');
  assert.equal(formatPlanStatus([{ step: 1, status: 'pending', description: { label: 'Build' } }]), '1. [ ] Build');
  assert.doesNotMatch(formatPlanStatus([{ step: 1, status: 'pending', description: { label: 'Build' } }]), /\[object Object\]/);
});

test('formatConfigValue renders objects as key-value text', () => {
  assert.equal(formatConfigValue({ requestsPerMinute: 60 }), 'requestsPerMinute: 60');
  assert.equal(formatConfigValue({ limits: { requestsPerMinute: 60 } }), 'limits: requestsPerMinute: 60');
  assert.doesNotMatch(formatConfigValue({ requestsPerMinute: 60 }), /\[object Object\]/);
});
