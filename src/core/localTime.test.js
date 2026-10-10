import assert from 'node:assert/strict';
import test from 'node:test';

// The zone is fixed BEFORE the module reads any date.
process.env.TZ = 'Europe/Paris';
const { formatLocalTime, formatLocalDateTime, localClockFromUtc, localizeLogLine } = await import('./localTime.js');

test('one event reads the same way everywhere, in local time', () => {
  const at = '2026-10-10T08:31:10.840Z';
  assert.equal(formatLocalTime(at), '10:31:10');
  assert.equal(formatLocalTime(at, { seconds: false }), '10:31');
  assert.equal(formatLocalDateTime(at), '2026-10-10 10:31');
  assert.equal(formatLocalDateTime(Date.parse(at), { seconds: true }), '2026-10-10 10:31:10');
  assert.equal(formatLocalTime('not a date'), '');
});

test('the runtime\'s UTC log clock is shown in local time', () => {
  const now = new Date('2026-10-10T09:00:00Z');
  // The journal showed 08:57:07 for an event at 10:57:07 in Paris.
  assert.equal(localizeLogLine('08:57:07 Maintenance: cycle completed', now), '10:57:07 Maintenance: cycle completed');
  // Just after midnight UTC, 23:59 is yesterday's.
  assert.equal(localClockFromUtc('23:59:00', new Date('2026-10-11T00:05:00Z')), '01:59:00');
  // A line without a leading clock is left alone.
  assert.equal(localizeLogLine('orchestrator: checkpoint 1/3', now), 'orchestrator: checkpoint 1/3');
});
