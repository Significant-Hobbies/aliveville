import { describe, expect, it, vi } from 'vitest';

import {
  matchEndpointRoute,
  reportEndpoint,
  withEndpointTelemetry,
} from '../worker/src/endpoint-telemetry.ts';

describe('Worker App Health endpoint telemetry', () => {
  it('matches only fixed JSON route and method pairs', () => {
    expect(matchEndpointRoute('GET', '/api/state')).toBe('/api/state');
    expect(matchEndpointRoute('POST', '/api/tick')).toBe('/api/tick');
    expect(matchEndpointRoute('GET', '/api/state/private-session')).toBeNull();
    expect(matchEndpointRoute('GET', '/api/state?session=private-session')).toBeNull();
    expect(matchEndpointRoute('POST', '/api/state')).toBeNull();
    expect(matchEndpointRoute('GET', '/api/events')).toBeNull();
    expect(matchEndpointRoute('POST', '/api/dialogue')).toBeNull();
    expect(matchEndpointRoute('POST', '/api/restore')).toBeNull();
  });

  it('sends only fixed route and response summary fields, preserving the game response', async () => {
    const request = new Request(
      'https://aliveville.example/game/api/tick?session=query-private&npc=private-name',
      {
        method: 'POST',
        headers: {
          'x-session-id': 'header-private',
          authorization: 'Bearer body-private',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'body-private', npcId: 'name-private' }),
      }
    );
    const responseBody = JSON.stringify({ ok: true, npc: 'visible-in-game-response' });
    const response = new Response(responseBody, { status: 200 });
    const dispatch = vi.fn(async () => response);
    const report = vi.fn();
    let clock = 10;

    const result = await withEndpointTelemetry(
      request.method,
      new URL(request.url).pathname.slice('/game'.length),
      {},
      vi.fn(),
      dispatch,
      () => (clock += 12),
      report
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result).toBe(response);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(responseBody);
    expect(report).toHaveBeenCalledOnce();
    const summary = report.mock.calls[0]?.[2];
    expect(summary).toEqual({
      method: 'POST',
      route: '/api/tick',
      status_code: 200,
      duration_ms: 12,
    });
    const serialized = JSON.stringify(summary);
    for (const privateValue of [
      'query-private',
      'header-private',
      'body-private',
      'name-private',
      'authorization',
      'visible-in-game-response',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('sends the V1 ingest batch without request-derived values', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => ({
      status: 202,
      body: null,
    }));
    vi.stubGlobal('fetch', fetch);
    const pending: Promise<unknown>[] = [];
    reportEndpoint(
      { APP_HEALTH_INGEST_KEY: 'test-only-ingest-key', APP_HEALTH_ENVIRONMENT: 'staging' },
      (delivery) => pending.push(delivery),
      { method: 'GET', route: '/api/worlds', status_code: 200, duration_ms: 19 }
    );
    await Promise.all(pending);

    expect(fetch).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const batch = JSON.parse(String(init.body)) as {
      schema_version: string;
      runtime: string;
      environment: string;
      events: Array<Record<string, unknown>>;
    };
    expect(batch).toMatchObject({
      schema_version: 'v1',
      runtime: 'worker',
      environment: 'staging',
    });
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      method: 'GET',
      route: '/api/worlds',
      status_code: 200,
      duration_ms: 19,
    });
    expect(Object.keys(batch.events[0] ?? {}).sort()).toEqual([
      'duration_ms',
      'event_id',
      'method',
      'route',
      'status_code',
      'timestamp',
    ]);
    const serialized = JSON.stringify(batch);
    for (const privateValue of ['test-only-ingest-key', 'session', 'headers', 'body', 'identity']) {
      expect(serialized).not.toContain(privateValue);
    }
    vi.unstubAllGlobals();
  });

  it('is a no-op until the Worker has an ingest key', () => {
    const waitUntil = vi.fn();
    reportEndpoint({}, waitUntil, {
      method: 'GET',
      route: '/api/worlds',
      status_code: 200,
      duration_ms: 19,
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('drops unmatched paths and records a 500 summary when a matched dispatch throws', async () => {
    const report = vi.fn();
    const unmatched = vi.fn(async () => new Response('not found', { status: 404 }));
    await withEndpointTelemetry(
      'GET',
      '/api/private-value',
      {},
      vi.fn(),
      unmatched,
      () => 1,
      report
    );
    expect(report).not.toHaveBeenCalled();

    const failure = new Error('request body should not be included');
    await expect(
      withEndpointTelemetry(
        'GET',
        '/api/worlds',
        {},
        vi.fn(),
        async () => {
          throw failure;
        },
        () => 7,
        report
      )
    ).rejects.toBe(failure);
    expect(report).toHaveBeenCalledWith({}, expect.any(Function), {
      method: 'GET',
      route: '/api/worlds',
      status_code: 500,
      duration_ms: 0,
    });
  });
});
