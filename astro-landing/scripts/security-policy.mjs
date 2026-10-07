import assert from 'node:assert/strict';

export function validateAudit(audit, status) {
  assert([0, 1].includes(status), `Audit command failed: ${status}`);
  assert(!audit.error && audit.advisories && audit.metadata?.vulnerabilities, 'Audit registry response must be valid');
  assert.equal(audit.muted?.length ?? 0, 0, 'Do not suppress audit findings');
  const findings = Object.values(audit.advisories);
  assert(findings.length <= 1, 'Additional advisories require remediation');
  for (const advisory of findings) {
    assert.equal(advisory.github_advisory_id, 'GHSA-ch52-4w7c-c8xp', 'An additional advisory requires remediation');
    assert.equal(advisory.module_name, 'http-cache-semantics');
    assert.equal(advisory.severity, 'high');
    assert.equal(advisory.patched_versions, '<0.0.0', 'An upstream patch is now available; apply it');
    assert(advisory.findings?.length > 0, 'The reviewed advisory must identify its installed path');
    for (const finding of advisory.findings) {
      assert.equal(finding.version, '4.2.0', 'Re-review a different cache package version');
      assert(finding.paths.length > 0 && finding.paths.every(path => path === '.>astro>http-cache-semantics'),
        'A new consumer of the cache package requires a fresh security review');
    }
  }
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    assert.equal(audit.metadata.vulnerabilities[severity], severity === 'high' ? findings.length : 0,
      'Audit metadata must agree with the reviewed finding');
  }
  assert.equal(status, findings.length ? 1 : 0, 'An unexplained audit failure must fail CI');
  return findings.length;
}
