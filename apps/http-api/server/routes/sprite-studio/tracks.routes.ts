/**
 * Animation-layer (track) CRUD — metadata lives in settings_json.tracks
 * (normalizeTracks injects the implicit Base/track 0), cells live in
 * sprite_frames.track. Deleting a track drops its cells; track 0 is
 * immutable (it is the timing master of the shared grid).
 *
 *   POST   /animations/:id/tracks            {name?}            → DTO
 *   PATCH  /animations/:id/tracks/:trackId   {name?, visible?}  → DTO
 *   DELETE /animations/:id/tracks/:trackId                      → DTO
 */
import type { Hono } from 'hono';
import type { SpriteAnimationRow } from '@mcp/store/sprite-studio/types.js';
import { addTrack, patchTrack, removeTrack } from '@mcp/store/sprite-studio/track-settings.js';
import type { ServerDeps } from '../../deps.js';
import { resolveAnim, toAnimDto } from './animation-helpers.js';

export function mountSpriteTrackRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteAnimationsStore;
  const dto = (animId: number) => {
    const anim = store.get(animId) as SpriteAnimationRow;
    return toAnimDto(anim, store.listFrames(animId));
  };

  app.post('/api/sprite-studio/animations/:id/tracks', async (c) => {
    const found = resolveAnim(deps, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const added = addTrack(found.anim.settings, body.name);
    if (!added) return c.json({ error: 'too_many_tracks' }, 400);
    store.mergeSettings(found.anim.id, { tracks: added.tracks });
    return c.json(dto(found.anim.id));
  });

  app.patch('/api/sprite-studio/animations/:id/tracks/:trackId', async (c) => {
    const found = resolveAnim(deps, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const trackId = Number(c.req.param('trackId'));
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; visible?: boolean };
    const tracks = patchTrack(found.anim.settings, trackId, body);
    if (!tracks) return c.json({ error: 'unknown_track' }, 404);
    store.mergeSettings(found.anim.id, { tracks });
    return c.json(dto(found.anim.id));
  });

  app.delete('/api/sprite-studio/animations/:id/tracks/:trackId', (c) => {
    const found = resolveAnim(deps, Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const trackId = Number(c.req.param('trackId'));
    if (trackId === 0) return c.json({ error: 'track_zero_immutable' }, 400);
    const tracks = removeTrack(found.anim.settings, trackId);
    if (!tracks) return c.json({ error: 'unknown_track' }, 404);
    store.deleteTrackFrames(found.anim.id, trackId);
    store.mergeSettings(found.anim.id, { tracks });
    return c.json(dto(found.anim.id));
  });
}
