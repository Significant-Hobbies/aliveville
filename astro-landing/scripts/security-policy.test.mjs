import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAudit } from './security-policy.mjs';

const clean = () => ({
  advisories: {},
  muted: [],
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
});

test('accepts an actually clean successful audit', () => {
  assert.equal(validateAudit(clean(), 0), 0);
});
test('rejects any advisory including the retired exception', () => {
  for (const id of ['GHSA-ch52-4w7c-c8xp', 'GHSA-new']) {
    const audit = clean();
    audit.advisories[id] = { github_advisory_id: id };
    assert.throws(() => validateAudit(audit, 0), /All advisories require remediation/);
  }
});
test('rejects nonzero metadata even without advisory details', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const audit = clean();
    audit.metadata.vulnerabilities[severity] = 1;
    assert.throws(() => validateAudit(audit, 0), /Audit metadata must be clean/);
  }
});
test('rejects registry errors and missing audit fields', () => {
  assert.throws(
    () => validateAudit({ ...clean(), error: { code: 'E503' } }, 0),
    /Audit registry response must be valid/
  );
  for (const field of ['advisories', 'metadata']) {
    const audit = clean();
    delete audit[field];
    assert.throws(() => validateAudit(audit, 0), /Audit registry response must be valid/);
  }
});
test('rejects muted findings even when the visible audit is clean', () => {
  const audit = clean();
  audit.muted = [{ github_advisory_id: 'GHSA-hidden' }];
  assert.throws(() => validateAudit(audit, 0), /Do not suppress audit findings/);
});
test('rejects unsuccessful commands even with a clean audit payload', () => {
  assert.throws(() => validateAudit(clean(), 1), /An unexplained audit failure must fail CI/);
  assert.throws(() => validateAudit(clean(), 2), /Audit command failed: 2/);
});
