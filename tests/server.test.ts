import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

function startServer(port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [TSX, SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
      AUTOSAVE: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      if (data.toString().includes('running at')) {
        child.stdout?.off('data', onData);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('server start timeout')), 6000);
  });
}

describe('server', () => {
  test('exposes state and accepts tick actions', async () => {
    const port = 5200 + Math.floor(Math.random() * 200);
    const child = await startServer(port);
    try {
      const stateRes = await fetch(`http://localhost:${port}/api/state`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as { id: string; npcs: unknown[] };
      expect(state.id).toBe('ashment');
      expect(Array.isArray(state.npcs)).toBe(true);

      const tickRes = await fetch(`http://localhost:${port}/api/tick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: { type: 'talk', targetId: 'lena', text: 'hello' } }),
      });
      expect(tickRes.status).toBe(200);
      const body = (await tickRes.json()) as {
        summary: { tick: number; actions: { action: { type: string } }[] };
      };
      expect(body.summary.tick).toBe(1);
      expect(body.summary.actions.some((entry) => entry.action.type === 'talk')).toBe(true);

      const pkgRes = await fetch(`http://localhost:${port}/api/story-package`);
      expect(pkgRes.status).toBe(200);
      const pkg = (await pkgRes.json()) as {
        package: { worldId: string; assets: { cutscenes: unknown[] } };
        issues: unknown[];
      };
      expect(pkg.package.worldId).toBe('ashment');
      expect(pkg.issues).toEqual([]);
      expect(Array.isArray(pkg.package.assets.cutscenes)).toBe(true);

      const importRes = await fetch(`http://localhost:${port}/api/import-story-package`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pkg.package),
      });
      expect(importRes.status).toBe(200);
      const imported = (await importRes.json()) as {
        state: { id: string; tick: number; player: { locationId: string } };
      };
      expect(imported.state.id).toBe('ashment');
      expect(imported.state.tick).toBe(0);
      expect(imported.state.player.locationId).toBe('square');

      const animeSource = JSON.parse(
        readFileSync(new URL('../fixtures/anime/opm-ingest-source.json', import.meta.url), 'utf8')
      ) as unknown;
      const animeRes = await fetch(`http://localhost:${port}/api/import-world-source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: animeSource }),
      });
      expect(animeRes.status).toBe(200);
      const animeImported = (await animeRes.json()) as {
        state: { id: string; name: string; npcs: Array<{ name: string }> };
      };
      expect(animeImported.state.id).toBe('opm_ingested_z_city');
      expect(animeImported.state.name).toBe('One Punch Man Playable Slice');
      expect(animeImported.state.npcs.map((npc) => npc.name)).toContain('Saitama');

      const loopStatus = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      expect(loopStatus.status).toBe(200);
      const statusBody = (await loopStatus.json()) as { state: string; ticksRun: number };
      expect(statusBody).toMatchObject({ state: 'idle', ticksRun: 0 });

      const stepRes = await fetch(`http://localhost:${port}/api/agent-loop/step`, {
        method: 'POST',
      });
      expect(stepRes.status).toBe(200);
      const stepBody = (await stepRes.json()) as {
        status: { ticksRun: number };
        state: { tick: number };
      };
      expect(stepBody.status.ticksRun).toBe(1);
      expect(stepBody.state.tick).toBe(1);
      for (let i = 0; i < 4; i += 1) {
        const checkpointStep = await fetch(`http://localhost:${port}/api/agent-loop/step`, {
          method: 'POST',
        });
        expect(checkpointStep.status).toBe(200);
      }
      const checkpointStatus = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      const checkpointStatusBody = (await checkpointStatus.json()) as {
        checkpoints: Array<{ tick: number }>;
      };
      expect(checkpointStatusBody.checkpoints[0]?.tick).toBe(5);

      const restoreCheckpoint = await fetch(
        `http://localhost:${port}/api/agent-loop/restore-checkpoint`,
        { method: 'POST' }
      );
      expect(restoreCheckpoint.status).toBe(200);
      const restored = (await restoreCheckpoint.json()) as {
        checkpoint: { tick: number };
        status: { restoredCheckpoint: { tick: number } };
        state: { tick: number };
      };
      expect(restored.checkpoint.tick).toBe(5);
      expect(restored.status.restoredCheckpoint.tick).toBe(5);
      expect(restored.state.tick).toBe(5);

      const reset = await fetch(`http://localhost:${port}/api/reset`, { method: 'POST' });
      expect(reset.status).toBe(200);
      const resetBody = (await reset.json()) as {
        state: { id: string; tick: number; player: { locationId: string } };
        agentLoopStatus: { checkpoints: unknown[]; ticksRun: number };
      };
      expect(resetBody.state).toMatchObject({
        id: 'ashment',
        tick: 0,
        player: { locationId: 'square' },
      });
      expect(resetBody.agentLoopStatus.ticksRun).toBe(0);
      expect(resetBody.agentLoopStatus.checkpoints).toEqual([]);
    } finally {
      child.kill();
    }
  });

  test('persists agent loop checkpoints across server restarts', async () => {
    const port = 5500 + Math.floor(Math.random() * 200);
    const checkpointDir = mkdtempSync(join(tmpdir(), 'ai-game-server-checkpoints-'));
    const checkpointFile = join(checkpointDir, 'agent-loop.json');
    const env = {
      AGENT_LOOP_CHECKPOINT_FILE: checkpointFile,
      AGENT_LOOP_MAX_CHECKPOINTS: '2',
    };
    let child: ChildProcess | null = null;

    try {
      child = await startServer(port, env);
      for (let i = 0; i < 5; i += 1) {
        const step = await fetch(`http://localhost:${port}/api/agent-loop/step`, {
          method: 'POST',
        });
        expect(step.status).toBe(200);
      }
      let status = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      let body = (await status.json()) as { checkpoints: Array<{ tick: number }> };
      expect(body.checkpoints.map((checkpoint) => checkpoint.tick)).toEqual([5]);
      child.kill();
      await waitForExit(child);

      child = await startServer(port, env);
      status = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      body = (await status.json()) as { checkpoints: Array<{ tick: number }> };
      expect(body.checkpoints.map((checkpoint) => checkpoint.tick)).toEqual([5]);

      const restore = await fetch(`http://localhost:${port}/api/agent-loop/restore-checkpoint`, {
        method: 'POST',
      });
      expect(restore.status).toBe(200);
      const restored = (await restore.json()) as {
        state: { tick: number };
        checkpoint: { tick: number };
      };
      expect(restored.checkpoint.tick).toBe(5);
      expect(restored.state.tick).toBe(5);
    } finally {
      child?.kill();
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  });

  test('stops a running agent loop before replacing world state', async () => {
    const port = 5700 + Math.floor(Math.random() * 200);
    const checkpointDir = mkdtempSync(join(tmpdir(), 'ai-game-server-replace-'));
    const checkpointFile = join(checkpointDir, 'agent-loop.json');
    const env = { AGENT_LOOP_CHECKPOINT_FILE: checkpointFile };
    let child: ChildProcess | null = null;
    try {
      child = await startServer(port, env);
      for (let i = 0; i < 5; i += 1) {
        const step = await fetch(`http://localhost:${port}/api/agent-loop/step`, {
          method: 'POST',
        });
        expect(step.status).toBe(200);
      }
      const checkpointStatus = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      expect(
        (await checkpointStatus.json()) as { checkpoints: Array<{ tick: number }> }
      ).toMatchObject({ checkpoints: [{ tick: 5 }] });

      const start = await fetch(`http://localhost:${port}/api/agent-loop/start`, {
        method: 'POST',
      });
      expect(start.status).toBe(200);
      expect((await start.json()) as { state: string }).toMatchObject({ state: 'running' });

      const animeSource = JSON.parse(
        readFileSync(new URL('../fixtures/anime/opm-ingest-source.json', import.meta.url), 'utf8')
      ) as unknown;
      const imported = await fetch(`http://localhost:${port}/api/import-world-source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: animeSource }),
      });

      expect(imported.status).toBe(200);
      const body = (await imported.json()) as {
        state: { id: string };
        agentLoopStatus: {
          state: string;
          ticksRun: number;
          lastTick: unknown;
          checkpoints: unknown[];
        };
      };
      expect(body.state.id).toBe('opm_ingested_z_city');
      expect(body.agentLoopStatus.state).toBe('stopped');
      expect(body.agentLoopStatus.ticksRun).toBe(0);
      expect(body.agentLoopStatus.lastTick).toBeNull();
      expect(body.agentLoopStatus.checkpoints).toEqual([]);

      const status = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      expect(
        (await status.json()) as {
          state: string;
          ticksRun: number;
          lastTick: unknown;
          checkpoints: unknown[];
        }
      ).toMatchObject({
        state: 'stopped',
        ticksRun: 0,
        lastTick: null,
        checkpoints: [],
      });

      const restore = await fetch(`http://localhost:${port}/api/agent-loop/restore-checkpoint`, {
        method: 'POST',
      });
      expect(restore.status).toBe(404);

      child.kill();
      await waitForExit(child);
      child = await startServer(port, env);
      const restarted = await fetch(`http://localhost:${port}/api/agent-loop/status`);
      expect((await restarted.json()) as { checkpoints: unknown[] }).toMatchObject({
        checkpoints: [],
      });
    } finally {
      child?.kill();
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  });

  test('sessions get isolated worlds', async () => {
    const port = 5900 + Math.floor(Math.random() * 200);
    const child = await startServer(port);
    try {
      // tick visitor-a's world twice; visitor-b and main stay untouched
      for (let i = 0; i < 2; i += 1) {
        const tick = await fetch(`http://localhost:${port}/api/tick?session=visitor-a`, {
          method: 'POST',
        });
        expect(tick.status).toBe(200);
      }
      const a = (await (
        await fetch(`http://localhost:${port}/api/state?session=visitor-a`)
      ).json()) as { tick: number };
      const b = (await (
        await fetch(`http://localhost:${port}/api/state?session=visitor-b`)
      ).json()) as { tick: number };
      const main = (await (await fetch(`http://localhost:${port}/api/state`)).json()) as {
        tick: number;
      };
      expect(a.tick).toBe(2);
      expect(b.tick).toBe(0);
      expect(main.tick).toBe(0);

      // world replacement is also per-session
      const animeSource = JSON.parse(
        readFileSync(new URL('../fixtures/anime/opm-ingest-source.json', import.meta.url), 'utf8')
      ) as unknown;
      const imported = await fetch(
        `http://localhost:${port}/api/import-world-source?session=visitor-a`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: animeSource }),
        }
      );
      expect(imported.status).toBe(200);
      const aAfter = (await (
        await fetch(`http://localhost:${port}/api/state?session=visitor-a`)
      ).json()) as { id: string };
      const mainAfter = (await (await fetch(`http://localhost:${port}/api/state`)).json()) as {
        id: string;
      };
      expect(aAfter.id).toBe('opm_ingested_z_city');
      expect(mainAfter.id).toBe('ashment');
    } finally {
      child.kill();
    }
  });

  test('admin token gates /api/restore and world replacement is rate limited', async () => {
    const port = 6100 + Math.floor(Math.random() * 200);
    const child = await startServer(port, { ADMIN_TOKEN: 'secret' });
    try {
      const world = (await (await fetch(`http://localhost:${port}/api/state`)).json()) as Record<
        string,
        unknown
      >;
      const denied = await fetch(`http://localhost:${port}/api/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ world }),
      });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`http://localhost:${port}/api/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': 'secret' },
        body: JSON.stringify({ world }),
      });
      expect(allowed.status).toBe(200);

      // replace_world bucket: 6 per 10 minutes (the restore above consumed none)
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const reset = await fetch(`http://localhost:${port}/api/reset?session=limited`, {
          method: 'POST',
        });
        statuses.push(reset.status);
      }
      expect(statuses.slice(0, 6).every((status) => status === 200)).toBe(true);
      expect(statuses[6]).toBe(429);
    } finally {
      child.kill();
    }
  });
});

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
}
