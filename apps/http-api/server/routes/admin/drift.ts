/**
 * Admin route for classifier drift detection.
 *
 *   GET /api/admin/drift?classifiers=off_topic,policy,...
 *     → Array of DriftReport, one per classifier with enough samples.
 *
 * Default classifiers (when none specified): the 5 quality classifiers
 * registered in deps.qualityClassifierPipeline.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { DriftDetector } from '@mcp/services/quality/index.js';

const DEFAULT_CLASSIFIERS = [
  'off_topic',
  'completeness',
  'code_quality',
  'policy',
  'tool_misuse',
];

export function mountAdminDriftRoutes(app: Hono, deps: ServerDeps): void {
  const { qualityClassificationStore } = deps;

  app.get('/api/admin/drift', (c) => {
    const classifierParam = c.req.query('classifiers');
    const recentHours = c.req.query('recent_hours');
    const baselineHours = c.req.query('baseline_hours');
    const minRows = c.req.query('min_rows');

    const detector = new DriftDetector({
      store: qualityClassificationStore,
      recentWindowMs: recentHours ? Number(recentHours) * 3_600_000 : undefined,
      baselineWindowMs: baselineHours ? Number(baselineHours) * 3_600_000 : undefined,
      minRows: minRows ? Number(minRows) : undefined,
    });

    const classifiers = classifierParam
      ? classifierParam.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_CLASSIFIERS;

    return c.json({
      reports: detector.detectAll(classifiers),
      requested: classifiers,
    });
  });
}
