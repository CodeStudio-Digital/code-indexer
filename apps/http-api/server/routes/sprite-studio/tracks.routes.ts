/**
 * Animation-layer (track) CRUD — metadata lives in settings_json.tracks
 * (normalizeTracks injects the implicit Base/track 0), cells live in
 * each frame entity's track field. Deleting a track drops its cells; track 0 is
 * immutable (it is the timing master of the shared grid).
 *
 *   POST   /animations/:id/tracks            {name?}            → DTO
 *   PATCH  /animations/:id/tracks/:trackId   {name?, visible?}  → DTO
 *   DELETE /animations/:id/tracks/:trackId                      → DTO
 */
import type { Hono } from 'hono';
import { addTrack, patchTrack, removeTrack } from '@mcp/store/sprite-studio/track-settings.js';
import type { ServerDeps } from '../../deps.js';
import { resolveAnim, toAnimDto } from './animation-helpers.js';

export function mountSpriteTrackRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteFileStore;
  const dto = async (animId: string) => {
    const anim = await store.getAnimation(animId);
    if (!anim) throw new Error(`Unknown animation ${animId}`);
    return toAnimDto(anim, await store.listFrames(animId));
  };

  app.post('/api/sprite-studio/animations/:id/tracks', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const added = addTrack(found.anim.settings, body.name);
    if (!added) return c.json({ error: 'too_many_tracks' }, 400);
    await store.mergeAnimationSettings(found.anim.id, { tracks: added.tracks });
    return c.json(await dto(found.anim.id));
  });

  app.patch('/api/sprite-studio/animations/:id/tracks/:trackId', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const trackId = Number(c.req.param('trackId'));
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; visible?: boolean };
    const tracks = patchTrack(found.anim.settings, trackId, body);
    if (!tracks) return c.json({ error: 'unknown_track' }, 404);
    await store.mergeAnimationSettings(found.anim.id, { tracks });
    return c.json(await dto(found.anim.id));
  });

  app.delete('/api/sprite-studio/animations/:id/tracks/:trackId', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    const trackId = Number(c.req.param('trackId'));
    if (trackId === 0) return c.json({ error: 'track_zero_immutable' }, 400);
    const tracks = removeTrack(found.anim.settings, trackId);
    if (!tracks) return c.json({ error: 'unknown_track' }, 404);
    await store.deleteTrackFrames(found.anim.id, trackId);
    await store.mergeAnimationSettings(found.anim.id, { tracks });
    return c.json(await dto(found.anim.id));
  });
}
