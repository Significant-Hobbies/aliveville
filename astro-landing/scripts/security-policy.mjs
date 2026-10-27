import assert from 'node:assert/strict';

export function validateAudit(audit, status) {
  assert([0, 1].includes(status), `Audit command failed: ${status}`);
  assert(
    !audit.error && audit.advisories && audit.metadata?.vulnerabilities,
    'Audit registry response must be valid'
  );
  assert.equal(audit.muted?.length ?? 0, 0, 'Do not suppress audit findings');
  assert.equal(Object.keys(audit.advisories).length, 0, 'All advisories require remediation');
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    assert.equal(audit.metadata.vulnerabilities[severity], 0, 'Audit metadata must be clean');
  }
  assert.equal(status, 0, 'An unexplained audit failure must fail CI');
  return 0;
}
