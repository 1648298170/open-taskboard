// 调试 requeueWake：直接对内存库跑一遍并打印每步状态。
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/index.js';

const db = new DatabaseSync(':memory:');
const store = new Store('.unused', db);
const project = store.createProject({ id: 'p1', name: 'P' });
const issueId = store.createIssue({ projectId: project.id, title: 'T' }).id;
const commentId = store.addComment(issueId, { author: 'web', body: '@agent x' }).id;

console.log('before claim:', JSON.stringify(store.queueMeta(commentId)));
const token = store.claimWake(commentId, 'watch');
console.log('token:', token);
console.log('after claim:', JSON.stringify(store.queueMeta(commentId)));
const ok = store.requeueWake(commentId, token!, 'boom', '2099-01-01T00:00:00.000Z');
console.log('requeue returned:', ok);
console.log('after requeue:', JSON.stringify(store.queueMeta(commentId)));
console.log('comment status:', store.getComment(commentId)!.status);
const row = db.prepare('SELECT attempts, last_error, not_before, claimed_by, status FROM comments WHERE id = ?').get(commentId);
console.log('raw row:', JSON.stringify(row));
