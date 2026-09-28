import { useEffect, useState } from 'react';

import { combatMovesFor } from '../../../src/combat.ts';
import { DEFAULT_HERO_NAME, sanitizePlayerName } from '../../../src/player-defaults.ts';
import type { CharacterAppearance, Npc, World } from '../../../src/types.ts';
import { api } from '../api/client.ts';
import { ensureAudio, uiBlip } from '../audio/sfx.ts';
import {
  type ActorVisual,
  actorVisualFor,
  type BodyShape,
  clothingColorsFor,
} from '../mapping/visuals.ts';
import {
  deleteSave,
  listSaves,
  opfsSupported,
  readSave,
  type SaveMeta,
} from '../platform/opfs-save.ts';
import { useUiStore } from '../store/ui.ts';
import { useWorldStore } from '../store/world.ts';
import { CharacterPortrait } from './CharacterPortrait.tsx';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(then)) return '';
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// showcase mode hides world-import UI; flip on with VITE_ENABLE_IMPORT=1
const IMPORT_ENABLED = import.meta.env['VITE_ENABLE_IMPORT'] === '1';

interface BundledWorld {
  id: string;
  name: string;
  blurb: string;
  kind: 'world' | 'source';
  beta?: boolean;
  showcase?: boolean;
}

/** Root flow: pick a world, then pick who you are in it. */
export function StartFlow() {
  const phase = useUiStore((state) => state.gamePhase);
  const setPhase = useUiStore((state) => state.setGamePhase);
  const world = useWorldStore((state) => state.world);
  const send = useWorldStore((state) => state.send);
  const [worlds, setWorlds] = useState<BundledWorld[]>([]);
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'title') return;
    void (async () => {
      try {
        const res = await fetch(api('/api/worlds'));
        const data = (await res.json()) as { worlds: BundledWorld[] };
        // the AI-demo showcase first, then regular worlds, then anime betas
        const rank = (w: BundledWorld) => (w.showcase ? 0 : w.beta ? 2 : 1);
        setWorlds([...data.worlds].sort((a, b) => rank(a) - rank(b)));
      } catch {
        setWorlds([]);
      }
    })();
    if (opfsSupported())
      void listSaves()
        .then(setSaves)
        .catch(() => setSaves([]));
  }, [phase]);

  const loadSlot = async (meta: SaveMeta) => {
    ensureAudio();
    uiBlip();
    setError(null);
    setBusy(meta.id);
    try {
      const record = await readSave(meta.id);
      if (!record) throw new Error('This save could not be read.');
      await useWorldStore.getState().loadFromSnapshot(record.world);
      setPhase('playing');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeSlot = async (id: string) => {
    uiBlip();
    await deleteSave(id);
    setSaves((current) => current.filter((save) => save.id !== id));
  };

  if (phase === 'playing') return null;

  const selectWorld = async (id: string | null) => {
    ensureAudio();
    uiBlip();
    setError(null);
    if (id === null) {
      // continue in the currently loaded world
      setPhase('character');
      return;
    }
    setBusy(id);
    try {
      const res = await fetch(api('/api/worlds/select'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`select failed: ${res.status}`);
      await useWorldStore.getState().init();
      setPhase('character');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const selectCharacter = async (
    npcId: string | null,
    heroName?: string,
    appearance?: CharacterAppearance
  ) => {
    ensureAudio();
    uiBlip();
    if (npcId) {
      setBusy(npcId);
      await send({
        type: 'choose_character',
        targetId: npcId,
        ...(appearance ? { appearance } : {}),
      });
      setBusy(null);
    } else {
      setBusy('name');
      await send({
        type: 'set_name',
        name: heroName || 'Wanderer',
        ...(appearance ? { appearance } : {}),
      });
      setBusy(null);
    }
    setPhase('playing');
  };

  return (
    <div className="start-flow">
      <div className="start-inner">
        <div className="start-brand">ALIVEVILLE</div>
        {phase === 'title' ? (
          <>
            {saves.length > 0 ? (
              <div className="start-section">
                <div className="start-heading">Continue your story</div>
                <div className="saves-list">
                  {saves.map((save) => (
                    <div key={save.id} className={`save-card ${busy === save.id ? 'busy' : ''}`}>
                      <button
                        type="button"
                        className="save-card-main"
                        disabled={busy !== null}
                        onClick={() => void loadSlot(save)}
                      >
                        <div className="save-card-name">
                          {busy === save.id ? 'Loading…' : save.name}
                        </div>
                        <div className="save-card-meta">
                          <span>{save.playerName}</span>
                          <span className="save-dot">·</span>
                          <span>
                            day {save.day}, {String(save.hour).padStart(2, '0')}:00
                          </span>
                          <span className="save-dot">·</span>
                          <span>Lv {save.level}</span>
                        </div>
                        <div className="save-card-time">{relativeTime(save.savedAt)}</div>
                      </button>
                      <button
                        type="button"
                        className="save-card-delete"
                        title="Delete this save"
                        aria-label={`Delete save ${save.name}`}
                        disabled={busy !== null}
                        onClick={() => void removeSlot(save.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="start-heading">Choose a world</div>
            <div className="start-grid">
              {world ? (
                <button
                  type="button"
                  className="start-card continue"
                  onClick={() => void selectWorld(null)}
                >
                  <div className="start-card-name">
                    Continue: {world.story?.title ?? world.name}
                  </div>
                  <div className="start-card-blurb">
                    Pick up where the world left off — day {world.clock.day}.
                  </div>
                </button>
              ) : null}
              {worlds.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`start-card ${entry.beta ? 'beta' : ''} ${entry.showcase ? 'showcase' : ''}`}
                  disabled={busy !== null}
                  onClick={() => void selectWorld(entry.id)}
                >
                  <div className="start-card-name">
                    {busy === entry.id ? 'Generating…' : entry.name}
                    {entry.showcase ? <span className="world-demo-badge">AI DEMO</span> : null}
                    {entry.beta ? <span className="world-beta-badge">BETA</span> : null}
                  </div>
                  <div className="start-card-blurb">{entry.blurb}</div>
                </button>
              ))}
            </div>
            {IMPORT_ENABLED ? (
              <FandomImport
                busy={busy}
                onStart={() => setBusy('fandom')}
                onDone={(err) => {
                  setBusy(null);
                  if (err) setError(err);
                  else setPhase('character');
                }}
              />
            ) : null}
          </>
        ) : (
          <CharacterSelect
            world={world}
            busy={busy}
            onPick={(id, name) => void selectCharacter(id, name)}
            onBack={() => setPhase('title')}
          />
        )}
        {error ? <div className="start-error">{error}</div> : null}
      </div>
    </div>
  );
}

/** type any franchise name — the server researches the fandom wiki and builds the world */
function FandomImport({
  busy,
  onStart,
  onDone,
}: {
  busy: string | null;
  onStart: () => void;
  onDone: (error: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const run = async () => {
    if (!query.trim() || busy) return;
    ensureAudio();
    uiBlip();
    onStart();
    setStatus('Researching the wiki and building the world… (~1 min)');
    try {
      const res = await fetch(api('/api/import-fandom'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; wiki?: string | null };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `import failed: ${res.status}`);
      setStatus(null);
      await useWorldStore.getState().init();
      onDone(null);
    } catch (error) {
      setStatus(null);
      onDone((error as Error).message);
    }
  };

  return (
    <div className="fandom-import">
      <div className="fandom-import-row">
        <input
          type="text"
          value={query}
          placeholder="Summon any world… e.g. Naruto, One Piece, Attack on Titan"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void run();
          }}
          disabled={busy !== null}
        />
        <button type="button" disabled={busy !== null || !query.trim()} onClick={() => void run()}>
          {busy === 'fandom' ? 'Summoning…' : 'Summon'}
        </button>
      </div>
      <div className="start-hint">
        {status ??
          'Built live from the fandom wiki — or paste world JSON in-game via “Import world”.'}
      </div>
    </div>
  );
}

const WANDERER = {
  id: null,
  name: 'The Wanderer',
  blurb: 'An outsider with no past here — write your own story.',
  color: '#c8382a',
};

const SKIN_TONES = ['#f6d2b0', '#e8b894', '#cf9a6c', '#a86b3c', '#7a4a28', '#4e3018'];
const OUTFIT_COLORS = [
  '#3c5a78',
  '#4a7a6a',
  '#7a4a52',
  '#56648a',
  '#6a5a3c',
  '#5d4a73',
  '#b23b3b',
  '#2f6f6f',
];
const ACCENT_COLORS = [
  '#e8c95a',
  '#7fd0ff',
  '#ff9a6a',
  '#b5e48c',
  '#e88aa8',
  '#9fe8dd',
  '#f2e2b0',
  '#c9b8ff',
];
const BUILDS: Array<{ key: BodyShape; label: string }> = [
  { key: 'slim', label: 'Slim' },
  { key: 'average', label: 'Average' },
  { key: 'broad', label: 'Broad' },
  { key: 'small', label: 'Small' },
  { key: 'caped', label: 'Caped' },
  { key: 'mechanical', label: 'Mech' },
];

interface LookState {
  skin: string;
  outfit: string;
  accent: string;
  build: BodyShape;
}

function initialLook(npc: Npc | null): LookState {
  if (npc) {
    const visual = actorVisualFor(npc.appearance, clothingColorsFor(npc.id).color);
    return {
      skin: visual.skinColor,
      outfit: visual.color,
      accent: visual.accentColor,
      build: visual.bodyShape,
    };
  }
  return { skin: '#e8b894', outfit: '#3c5a78', accent: '#e8c95a', build: 'average' };
}

function SwatchRow({
  label,
  colors,
  value,
  onChange,
}: {
  label: string;
  colors: string[];
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="look-row">
      <span className="look-label">{label}</span>
      <div className="look-swatches">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            className={`look-swatch ${value.toLowerCase() === color.toLowerCase() ? 'selected' : ''}`}
            style={{ background: color }}
            aria-label={`${label}: ${color}`}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
}

function CharacterSelect({
  world,
  busy,
  onPick,
  onBack,
}: {
  world: World | null;
  busy: string | null;
  onPick: (npcId: string | null, heroName?: string, appearance?: CharacterAppearance) => void;
  onBack: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [heroName, setHeroName] = useState(DEFAULT_HERO_NAME);
  const npcs = (world?.npcs ?? []).filter((npc) => !npc.combat?.defeated);
  const selected = selectedId ? (npcs.find((npc) => npc.id === selectedId) ?? null) : null;

  return (
    <>
      <div className="start-heading">Who are you in {world?.story?.title ?? world?.name}?</div>
      <div className="start-columns">
        <div className="start-list">
          <button
            type="button"
            className={`start-card continue ${selectedId === null ? 'selected' : ''}`}
            onClick={() => setSelectedId(null)}
          >
            <span className="start-swatch" style={{ background: WANDERER.color }} />
            <div className="start-card-name">{WANDERER.name}</div>
            <div className="start-card-blurb">{WANDERER.blurb}</div>
          </button>
          {npcs.map((npc) => {
            const visual = actorVisualFor(npc.appearance, clothingColorsFor(npc.id).color);
            return (
              <button
                key={npc.id}
                type="button"
                className={`start-card ${selectedId === npc.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(npc.id)}
              >
                <span className="start-swatch" style={{ background: visual.color }} />
                <div className="start-card-name">{npc.name}</div>
                <div className="start-card-blurb">
                  {npc.role ?? npc.description?.slice(0, 70) ?? ''}
                </div>
              </button>
            );
          })}
        </div>
        {world ? (
          <CharacterDetail
            world={world}
            npc={selected}
            busy={busy}
            heroName={heroName}
            onHeroNameChange={setHeroName}
            onPick={onPick}
          />
        ) : null}
      </div>
      <button type="button" className="start-back" onClick={onBack}>
        ← Back to worlds
      </button>
    </>
  );
}

function CharacterDetail({
  world,
  npc,
  busy,
  heroName,
  onHeroNameChange,
  onPick,
}: {
  world: World;
  npc: Npc | null;
  busy: string | null;
  heroName: string;
  onHeroNameChange: (name: string) => void;
  onPick: (npcId: string | null, heroName?: string, appearance?: CharacterAppearance) => void;
}) {
  const hp = npc?.combat?.maxHp ?? 120;
  const moves = combatMovesFor({
    ...world,
    player: { ...world.player, characterId: npc?.id ?? undefined },
  } as World).slice(0, 4);
  const locationName = npc
    ? world.locations.find((entry) => entry.id === npc.locationId)?.name
    : 'the city gates';
  const personality = [...(npc?.traits?.personality ?? []), ...(npc?.traits?.values ?? [])].slice(
    0,
    5
  );
  const goal = npc?.goals?.[0] ?? npc?.ambitions?.[0]?.title;

  // look state, reset whenever the selected character changes (render-time keyed reset)
  const [lookNpcId, setLookNpcId] = useState<string | null>(npc?.id ?? null);
  const [look, setLook] = useState<LookState>(() => initialLook(npc));
  if (lookNpcId !== (npc?.id ?? null)) {
    setLookNpcId(npc?.id ?? null);
    setLook(initialLook(npc));
  }

  // drives the live turntable preview AND what we persist on pick
  const previewVisual: ActorVisual = {
    color: look.outfit,
    accentColor: look.accent,
    skinColor: look.skin,
    bodyShape: look.build,
  };
  const chosenAppearance: CharacterAppearance = {
    ...(npc?.appearance ?? {}),
    palette: [look.outfit, look.skin, look.accent],
    bodyType: look.build,
  };

  return (
    <div className="char-detail">
      <div className="char-detail-main">
        <CharacterPortrait visual={previewVisual} npc={npc} />
        <div className="char-detail-body">
          <div className="char-detail-head">
            <div>
              <div className="char-detail-name">{npc?.name ?? WANDERER.name}</div>
              <div className="char-detail-role">
                {npc?.role ?? 'outsider'}
                {npc?.tier === 'quest' ? <span className="char-badge">key figure</span> : null}
              </div>
            </div>
          </div>
          <div className="char-detail-desc">{npc?.description ?? WANDERER.blurb}</div>
        </div>
      </div>
      {personality.length > 0 ? (
        <div className="char-chips">
          {personality.map((trait) => (
            <span key={trait} className="char-chip">
              {trait}
            </span>
          ))}
        </div>
      ) : null}
      {goal ? <div className="char-goal">Wants: {goal}</div> : null}
      <div className="char-stats">
        <div className="char-stat">
          <span className="char-stat-label">HP</span> {hp}
        </div>
        <div className="char-stat">
          <span className="char-stat-label">Level</span> 1
        </div>
        <div className="char-stat">
          <span className="char-stat-label">Starts at</span> {locationName}
        </div>
      </div>
      <div className="char-moves">
        {moves.map((move) => (
          <div key={move.id} className="char-move">
            <span className="char-move-name">{move.label}</span>
            <span className="char-move-meta">
              {move.style} · {move.damage} dmg
            </span>
          </div>
        ))}
      </div>
      {!npc ? (
        <div className="hero-name-row">
          <label className="hero-name-label" htmlFor="hero-name-input">
            Your name
          </label>
          <input
            id="hero-name-input"
            className="hero-name-input"
            type="text"
            value={heroName}
            maxLength={20}
            onChange={(event) => {
              const cleaned = sanitizePlayerName(event.target.value);
              onHeroNameChange(cleaned ?? DEFAULT_HERO_NAME);
            }}
          />
        </div>
      ) : null}
      <div className="char-look">
        <div className="char-look-title">Appearance</div>
        <SwatchRow
          label="Skin"
          colors={SKIN_TONES}
          value={look.skin}
          onChange={(skin) => setLook((current) => ({ ...current, skin }))}
        />
        <SwatchRow
          label="Outfit"
          colors={OUTFIT_COLORS}
          value={look.outfit}
          onChange={(outfit) => setLook((current) => ({ ...current, outfit }))}
        />
        <SwatchRow
          label="Accent"
          colors={ACCENT_COLORS}
          value={look.accent}
          onChange={(accent) => setLook((current) => ({ ...current, accent }))}
        />
        <div className="look-row">
          <span className="look-label">Build</span>
          <div className="look-builds">
            {BUILDS.map((build) => (
              <button
                key={build.key}
                type="button"
                className={`look-build ${look.build === build.key ? 'selected' : ''}`}
                onClick={() => setLook((current) => ({ ...current, build: build.key }))}
              >
                {build.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="char-pick"
        data-app-health-event="game.begin.clicked"
        disabled={busy !== null}
        onClick={() => onPick(npc?.id ?? null, npc ? undefined : heroName, chosenAppearance)}
      >
        {busy ? 'Becoming…' : npc ? `Become ${npc.name}` : 'Begin as the Wanderer'}
      </button>
    </div>
  );
}
