import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { Store } from '@taskboard/core';

const store = new Store('.unused', new DatabaseSync(':memory:'));
const { app } = await buildApp({ store, env: {} });
const H = { 'content-type': 'application/json' };
await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { id: 'p1', name: 'P' } });
const a = (await app.inject({ method: 'POST', url: '/api/projects/p1/issues', headers: H, payload: { title: 'A' } })).json().id;
const b = (await app.inject({ method: 'POST', url: '/api/projects/p1/issues', headers: H, payload: { title: 'B' } })).json().id;
await app.inject({ method: 'POST', url: `/api/issues/${b}/dependencies`, headers: H, payload: { dependsOnId: a } });
await app.inject({ method: 'PATCH', url: `/api/issues/${a}`, headers: H, payload: { status: 'done' } });
const res = await app.inject({ method: 'GET', url: '/api/projects/p1/next' });
const body = res.json();
console.log('issue type:', typeof body.issue, '| body.issue.id:', body.issue?.id, '| b:', b, '| equal:', body.issue?.id === b);
await app.close();
