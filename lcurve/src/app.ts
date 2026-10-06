/**
 * HTTP 接口层。路由与校验规则详见 README.md。
 */

import express, { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { LCurveService, ServiceError } from './service';

export function createApp(pool: Pool): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const svc = new LCurveService(pool);

  const h = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // 部件与改型关系
  app.post('/parts', h(async (req, res) => {
    const { partId, name } = req.body ?? {};
    const r = await svc.createPart({ partId, name });
    res.status(r.created ? 201 : 200).json(r);
  }));

  app.get('/parts', h(async (_req, res) => {
    res.json({ parts: await svc.listParts() });
  }));

  app.get('/parts/:partId', h(async (req, res) => {
    const proj = await svc.getProjection(req.params.partId!, asOf(req));
    if (!proj.exists) throw new ServiceError('PART_NOT_FOUND', `部件 ${req.params.partId} 不存在`, 404);
    res.json(proj);
  }));

  app.post('/parts/:partId/variant', h(async (req, res) => {
    const { parentId, priorStrength, priorLearningRate } = req.body ?? {};
    await svc.declareVariant(req.params.partId!, { parentId, priorStrength, priorLearningRate });
    res.status(201).json({ declared: true });
  }));

  // 批次事件（录入/更正/作废）
  app.post('/parts/:partId/events', h(async (req, res) => {
    const r = await svc.submitBatchEvent(req.params.partId!, req.body ?? {});
    res.status(r.duplicate ? 200 : 201).json(r);
  }));

  app.get('/parts/:partId/events', h(async (req, res) => {
    res.json({ events: await svc.listEvents(req.params.partId!, asOf(req)) });
  }));

  app.get('/parts/:partId/batches', h(async (req, res) => {
    const proj = await svc.getProjection(req.params.partId!, asOf(req));
    if (!proj.exists) throw new ServiceError('PART_NOT_FOUND', `部件 ${req.params.partId} 不存在`, 404);
    res.json({ partId: proj.partId, nextUnit: proj.nextUnit, batches: proj.batches });
  }));

  // 拟合（当前或历史时点）
  app.get('/parts/:partId/fit', h(async (req, res) => {
    res.json(await svc.getFit(req.params.partId!, asOf(req)));
  }));

  // 交付计划预测
  app.post('/parts/:partId/predictions', h(async (req, res) => {
    const { plan, asOf: bodyAsOf } = req.body ?? {};
    res.json(await svc.predict(req.params.partId!, plan, bodyAsOf ?? asOf(req)));
  }));

  // 两时点拟合/预测对比
  app.post('/parts/:partId/compare', h(async (req, res) => {
    const { from, to, plan } = req.body ?? {};
    res.json(await svc.compare(req.params.partId!, from, to, plan));
  }));

  // 错误处理
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) {
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '内部错误' } });
  });

  return app;
}

function asOf(req: Request): string | undefined {
  const v = req.query.asOf;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
