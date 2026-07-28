// Vercel Serverless Function: GET /api/stats
// Resolves every project in projects.json to live Roblox data, floored by the last-known
// snapshot. Roblox returns a masked payload (id 0 / "[TITLE UNAVAILABLE]") to throttled or
// region-restricted callers, and a real visit count never decreases — so any live number
// below the snapshot is bad data and is discarded.
//
// Cached at the edge for 60s.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_USER_ID = 2530954279;

export default async function handler(req, res) {
  try {
    const file = path.join(process.cwd(), 'projects.json');
    const cfg = JSON.parse(await fs.readFile(file, 'utf-8'));
    const entries = cfg.projects || [];

    const universeIds = await Promise.all(entries.map(resolveUniverseId));
    const [games, thumbnails] = await Promise.all([
      fetchGames(universeIds).catch(err => {
        console.error('games multiget failed', err.message);
        return new Map();
      }),
      fetchThumbnails(universeIds).catch(() => new Map()),
    ]);

    const projects = entries
      .map((p, i) => buildProject(p, universeIds[i], games, thumbnails))
      .filter(Boolean);

    const total = projects.reduce(
      (acc, p) => ({
        visits: acc.visits + (p.visits || 0),
        playing: acc.playing + (p.playing || 0),
      }),
      { visits: 0, playing: 0 }
    );

    const avatar = await fetchAvatar(cfg.userId || DEFAULT_USER_ID).catch(() => null);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ projects, total, avatar, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('stats handler error', err);
    res.status(500).json({ error: 'Failed to load stats', detail: err.message });
  }
}

function buildProject(p, universeId, games, thumbnails) {
  const snapshot = p.fallback || null;
  const game = games.get(String(universeId)) || null;
  if (!game && !snapshot) return null;

  const images = thumbnails.get(String(universeId)) || [];
  const liveVisits = game && Number.isFinite(game.visits) ? game.visits : 0;
  const knownVisits = snapshot && Number.isFinite(snapshot.visits) ? snapshot.visits : 0;

  return {
    placeId: p.placeId,
    universeId: universeId || null,
    role: p.role,
    description: p.description,
    name: (game && game.name) || (snapshot && snapshot.name) || null,
    visits: Math.max(liveVisits, knownVisits),
    playing: game && Number.isFinite(game.playing) ? game.playing : 0,
    url: `https://www.roblox.com/games/${(game && game.rootPlaceId) || p.placeId}`,
    images,
    thumbnail: images[0] || null,
    live: Boolean(game),
    lastKnownAt: (snapshot && snapshot.asOf) || null,
  };
}

async function resolveUniverseId(p) {
  if (p.universeId) return String(p.universeId);
  try {
    const r = await fetch(`https://apis.roblox.com/universes/v1/places/${p.placeId}/universe`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.universeId ? String(j.universeId) : null;
  } catch {
    return null;
  }
}

async function fetchGames(universeIds) {
  const ids = universeIds.filter(Boolean);
  if (!ids.length) return new Map();

  const r = await fetch(`https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`);
  if (!r.ok) throw new Error(`games api ${r.status}`);
  const j = await r.json();

  const out = new Map();
  for (const game of j.data || []) {
    if (!game || !game.id || game.name === '[TITLE UNAVAILABLE]') continue;
    out.set(String(game.id), game);
  }
  return out;
}

async function fetchThumbnails(universeIds) {
  const ids = universeIds.filter(Boolean);
  if (!ids.length) return new Map();

  const r = await fetch(
    `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${ids.join(',')}&countPerUniverse=10&size=768x432&format=Png`
  );
  if (!r.ok) return new Map();
  const j = await r.json();

  const out = new Map();
  for (const entry of j.data || []) {
    const urls = (entry.thumbnails || [])
      .filter(t => t.state === 'Completed' && t.imageUrl)
      .map(t => t.imageUrl);
    if (urls.length) out.set(String(entry.universeId), urls);
  }
  return out;
}

async function fetchAvatar(userId) {
  const r = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
  );
  if (!r.ok) return null;
  const j = await r.json();
  const first = j && j.data && j.data[0];
  return first && first.state === 'Completed' ? first.imageUrl : null;
}
