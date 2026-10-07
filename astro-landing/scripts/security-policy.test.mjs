import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAudit } from './security-policy.mjs';

const reviewed = () => ({
  advisories: { known: {
    github_advisory_id: 'GHSA-ch52-4w7c-c8xp', module_name: 'http-cache-semantics',
    severity: 'high', patched_versions: '<0.0.0',
    findings: [{ version: '4.2.0', paths: ['.>astro>http-cache-semantics'] }],
  } }, muted: [], metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
});

test('retains the sole reviewed finding and accepts an actually clean report', () => {
  assert.equal(validateAudit(reviewed(), 1), 1);
  const clean = reviewed(); clean.advisories = {}; clean.metadata.vulnerabilities.high = 0;
  assert.equal(validateAudit(clean, 0), 0);
});
test('new critical advisory cannot inherit the known disposition', () => {
  const audit = reviewed(); audit.advisories.new = { github_advisory_id: 'GHSA-new', severity: 'critical' };
  assert.throws(() => validateAudit(audit, 1));
});
test('same advisory through a new runtime consumer or version requires review', () => {
  const audit = reviewed(); audit.advisories.known.findings[0].paths.push('.>runtime>http-cache-semantics');
  assert.throws(() => validateAudit(audit, 1));
  const upgraded = reviewed(); upgraded.advisories.known.findings[0].version = '4.3.0';
  assert.throws(() => validateAudit(upgraded, 1));
});
test('registry errors, missing findings, and inconsistent counts cannot look clean', () => {
  assert.throws(() => validateAudit({ error: { code: 'E503' } }, 1));
  const incomplete = reviewed(); incomplete.advisories = {};
  assert.throws(() => validateAudit(incomplete, 0));
  assert.throws(() => validateAudit(reviewed(), 2));
});
test('published patch forces remediation rather than permanent tolerance', () => {
  const audit = reviewed(); audit.advisories.known.patched_versions = '>=4.3.1';
  assert.throws(() => validateAudit(audit, 1), /patch is now available/);
});
test('muted findings and unexplained exit failures fail closed', () => {
  const audit = reviewed(); audit.muted = [{ github_advisory_id: 'GHSA-hidden' }];
  assert.throws(() => validateAudit(audit, 1));
  assert.throws(() => validateAudit(reviewed(), 0));
});
