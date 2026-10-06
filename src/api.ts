/**
 * HTTP API（Express）。只负责请求/响应与校验，领域逻辑在 service/store。
 *
 * 端点一览：
 *   GET    /health
 *   POST   /parts                              创建部件
 *   GET    /parts                              部件列表
 *   GET    /parts/:partId                      部件当前状态（投影）
 *   PUT    /parts/:partId/inheritance          声明/更新改型继承
 *   GET    /parts/:partId/inheritance          查询继承关系
 *   DELETE /parts/:partId/inheritance          删除继承关系
 *   POST   /parts/:partId/events               提交批次事件（录入/更正/作废，幂等）
 *   GET    /parts/:partId/events               事件流
 *   GET    /parts/:partId/fit?asOf=&method=    当前或历史时点拟合结果
 *   POST   /parts/:partId/predictions          提交交付计划并取预测
 *   POST   /parts/:partId/compare              对比两个时点的拟合与预测差异
 */
import express, { Express, NextFunction, Request, Response } from 'express';
import { ConflictError, DomainError, NotFoundError, ValidationError } from './errors';
import { MidpointMethod } from './midpoint';
import { wouldCreateCycle } from './prior';
import { Service } from './service';
import { Store } from './store';
import { parseDateParam, parseEventBody, parsePlan } from './validate';

type Handler = (req: Request) => Promise<[number, unknown]>;

function h(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [status, body] = await fn(req);
      res.status(status).json(body);
    } catch (e) {
      next(e);
    }
  };
}

function parseMethod(value: unknown): MidpointMethod {
  if (value === undefined || value === null || value === '') return 'exact';
  if (value === 'exact' || value === 'approx') return value;
  throw new ValidationError("method 必须是 'exact' 或 'approx'");
}

export function createApp(service: Service, store: Store): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post(
    '/parts',
    h(async (req) => {
      const { partId, name } = req.body ?? {};
      if (typeof partId !== 'string' || partId.length === 0) {
        throw new ValidationError('partId 必须是非空字符串');
      }
      if (typeof name !== 'string' || name.length === 0) {
        throw new ValidationError('name 必须是非空字符串');
      }
      await store.createPart(partId, name);
      return [201, { partId, name }];
    }),
  );

  app.get(
    '/parts',
    h(async () => [200, { parts: await store.listParts() }]),
  );

  app.get(
    '/parts/:partId',
    h(async (req) => [200, await service.getState(req.params.partId)]),
  );

  app.put(
    '/parts/:partId/inheritance',
    h(async (req) => {
      const childId = req.params.partId;
      const { parentId, priorLearningRate, strength } = req.body ?? {};
      if (typeof parentId !== 'string' || parentId.length === 0) {
        throw new ValidationError('parentId 必须是非空字符串');
      }
      if (parentId === childId) throw new ValidationError('部件不能继承自身');
      if (!(await store.getPart(childId))) throw new NotFoundError(`部件 ${childId} 不存在`);
      if (!(await store.getPart(parentId))) throw new NotFoundError(`母型 ${parentId} 不存在`);
      if (priorLearningRate !== undefined && priorLearningRate !== null) {
        if (
          typeof priorLearningRate !== 'number' ||
          !(priorLearningRate > 0) ||
          priorLearningRate > 1
        ) {
          throw new ValidationError('学习率先验必须在 (0, 1] 区间');
        }
      }
      const nu = strength === undefined || strength === null ? 8 : strength;
      if (typeof nu !== 'number' || !Number.isFinite(nu) || nu <= 0) {
        throw new ValidationError('先验强度 strength 必须是正数');
      }
      const edges = await store.listInheritanceEdges();
      if (wouldCreateCycle(edges, childId, parentId)) {
        throw new ConflictError(`改型继承关系 ${childId} → ${parentId} 会成环`);
      }
      const edge = await store.setInheritance(childId, parentId, priorLearningRate ?? null, nu);
      return [200, edge];
    }),
  );

  app.get(
    '/parts/:partId/inheritance',
    h(async (req) => {
      const edge = await store.getInheritance(req.params.partId);
      if (!edge) throw new NotFoundError('该部件没有继承关系');
      return [200, edge];
    }),
  );

  app.delete(
    '/parts/:partId/inheritance',
    h(async (req) => {
      const removed = await store.deleteInheritance(req.params.partId);
      if (!removed) throw new NotFoundError('该部件没有继承关系');
      return [200, { removed: true }];
    }),
  );

  app.post(
    '/parts/:partId/events',
    h(async (req) => {
      const partId = req.params.partId;
      if (!(await store.getPart(partId))) throw new NotFoundError(`部件 ${partId} 不存在`);
      const ev = parseEventBody(req.body);
      const result = await store.appendEvent(partId, ev);
      return [result.outcome === 'applied' ? 201 : 200, result];
    }),
  );

  app.get(
    '/parts/:partId/events',
    h(async (req) => {
      if (!(await store.getPart(req.params.partId))) {
        throw new NotFoundError(`部件 ${req.params.partId} 不存在`);
      }
      const events = await store.listEvents(req.params.partId);
      return [200, { events }];
    }),
  );

  app.get(
    '/parts/:partId/fit',
    h(async (req) => {
      const asOf = parseDateParam(req.query.asOf as string | undefined);
      const method = parseMethod(req.query.method);
      return [200, await service.getFit(req.params.partId, asOf ?? undefined, method)];
    }),
  );

  app.post(
    '/parts/:partId/predictions',
    h(async (req) => {
      const plan = parsePlan(req.body);
      const asOf = parseDateParam(req.body?.asOf);
      const method = parseMethod(req.body?.method);
      return [200, await service.predict(req.params.partId, plan, asOf, method)];
    }),
  );

  app.post(
    '/parts/:partId/compare',
    h(async (req) => {
      const from = parseDateParam(req.body?.from, 'from');
      if (!from) throw new ValidationError('from 必须是 ISO 日期时间');
      const to = parseDateParam(req.body?.to, 'to'); // 缺省 = 当前
      const method = parseMethod(req.body?.method);
      const plan = req.body?.plan !== undefined ? parsePlan(req.body.plan) : null;
      return [200, await service.compare(req.params.partId, from, to, plan, method)];
    }),
  );

  // 统一错误映射
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const pgErr = err as { code?: string; detail?: string; message?: string; type?: string };
    if (pgErr && pgErr.code === '23505') {
      res.status(409).json({
        error: { code: 'CONFLICT', message: `唯一性冲突：${pgErr.detail ?? pgErr.message}` },
      });
      return;
    }
    if (pgErr && pgErr.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION', message: '请求体不是合法 JSON' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '内部错误' } });
  });

  return app;
}
