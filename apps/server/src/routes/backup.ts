// v0.4 P0: manual backup trigger. T6-32 covers the startup snapshot; this is
// the explicit on-demand path. Deliberately ignores TASKBOARD_BACKUPS=0 — an
// explicit request always backs up. READONLY mode still 403s it via the
// global write gate (a snapshot is a disk write).
import { FastifyPluginAsync } from 'fastify';
import { Store } from '@taskboard/core';

const backupRoutes: FastifyPluginAsync<{ store: Store; backupDir: string }> = async (app, { store, backupDir }) => {
  app.post('/api/backup', async () => {
    return { path: store.backupTo(backupDir) };
  });
};

export default backupRoutes;
