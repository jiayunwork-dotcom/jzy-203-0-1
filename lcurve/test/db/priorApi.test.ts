/**
 * 改型先验端到端：声明关系、少数据时向母型靠拢、多数据时以自身为主、
 * 非法先验与成环拒收。
 */

import { closeDb, makeService, resetDb } from '../helpers/db';
import { genBatches } from '../helpers/gen';
import { LCurveService } from '../../src/service';

beforeAll(resetDb);
afterAll(closeDb);

async function recordExact(
  svc: LCurveService,
  partId: string,
  t1: number,
  lr: number,
  sizes: number[],
  idPrefix = 'B',
) {
  const batches = genBatches(t1, lr, sizes, 1, idPrefix);
  for (const b of batches) {
    await svc.submitBatchEvent(partId, {
      eventId: `${partId}-${b.batchId}`,
      type: 'batch_recorded',
      batchId: b.batchId!,
      quantity: b.lastUnit - b.firstUnit + 1,
      hours: b.hours,
    });
  }
}

describe('改型先验（端到端）', () => {
  test('少数据向母型靠拢，多数据以自身为主', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'PARENT' });
    await recordExact(svc, 'PARENT', 100, 0.8, Array(10).fill(10));
    const parentFit = await svc.getFit('PARENT');
    expect(Math.abs(parentFit.learningRate! - 0.8)).toBeLessThan(1e-6);

    await svc.createPart({ partId: 'CHILD' });
    await svc.declareVariant('CHILD', { parentId: 'PARENT' });

    // 1 批自身数据（来自 LR=70% 曲线）：学习率应≈母型 80%
    await recordExact(svc, 'CHILD', 100, 0.7, [10]);
    let fit = await svc.getFit('CHILD');
    expect(fit.status).toBe('ok');
    expect(fit.prior!.source).toBe('parent_fit');
    expect(Math.abs(fit.learningRate! - 0.8)).toBeLessThan(1e-6);
    expect(fit.prior!.informationShare).toBeGreaterThan(0.99);

    // 再录 29 批（累计 30 批）：以自身数据为主，学习率回到 70% 附近
    const more = genBatches(100, 0.7, Array(29).fill(10), 11, 'C');
    for (const b of more) {
      await svc.submitBatchEvent('CHILD', {
        eventId: `CHILD-${b.batchId}`,
        type: 'batch_recorded',
        batchId: b.batchId!,
        quantity: b.lastUnit - b.firstUnit + 1,
        hours: b.hours,
      });
    }
    fit = await svc.getFit('CHILD');
    expect(Math.abs(fit.learningRate! - 0.7)).toBeLessThan(0.02);
    expect(fit.prior!.informationShare).toBeLessThan(0.15);
  });

  test('母型无拟合时用显式先验值', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'P2' }); // 母型暂无数据
    await svc.createPart({ partId: 'C2' });
    await svc.declareVariant('C2', { parentId: 'P2', priorLearningRate: 0.85 });
    await recordExact(svc, 'C2', 100, 0.7, [10]);
    const fit = await svc.getFit('C2');
    expect(fit.prior!.source).toBe('explicit');
    expect(Math.abs(fit.learningRate! - 0.85)).toBeLessThan(1e-9);
  });

  test('学习率先验不在 (0,1] 拒收；先验强度非法拒收', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'P3' });
    await svc.createPart({ partId: 'C3' });
    await expect(svc.declareVariant('C3', { parentId: 'P3', priorLearningRate: 1.2 }))
      .rejects.toMatchObject({ code: 'INVALID_PRIOR_LEARNING_RATE' });
    await expect(svc.declareVariant('C3', { parentId: 'P3', priorLearningRate: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_PRIOR_LEARNING_RATE' });
    await expect(svc.declareVariant('C3', { parentId: 'P3', priorLearningRate: -0.5 }))
      .rejects.toMatchObject({ code: 'INVALID_PRIOR_LEARNING_RATE' });
    await expect(svc.declareVariant('C3', { parentId: 'P3', priorStrength: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_PRIOR_STRENGTH' });
    await expect(svc.declareVariant('C3', { parentId: 'P3', priorStrength: 1e9 }))
      .rejects.toMatchObject({ code: 'INVALID_PRIOR_STRENGTH' });
    // 合法值：学习率=1（不学习）允许
    await expect(svc.declareVariant('C3', { parentId: 'P3', priorLearningRate: 1 }))
      .resolves.toBeUndefined();
  });

  test('改型关系成环拒收', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'A' });
    await svc.createPart({ partId: 'B' });
    await svc.createPart({ partId: 'C' });
    await svc.declareVariant('B', { parentId: 'A' });
    await svc.declareVariant('C', { parentId: 'B' });
    // 直接环
    await expect(svc.declareVariant('A', { parentId: 'A' }))
      .rejects.toMatchObject({ code: 'VARIANT_CYCLE' });
    // 间接环 A → C → B → A
    await expect(svc.declareVariant('A', { parentId: 'C' }))
      .rejects.toMatchObject({ code: 'VARIANT_CYCLE' });
    // 不存在的母型
    await expect(svc.declareVariant('A', { parentId: 'GHOST' }))
      .rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
  });

  test('多级继承：孙件沿链取到最近母型的学习率', async () => {
    const svc = makeService();
    await svc.createPart({ partId: 'G0' });
    await recordExact(svc, 'G0', 100, 0.9, Array(8).fill(10));
    await svc.createPart({ partId: 'G1' });
    await svc.declareVariant('G1', { parentId: 'G0' });
    await svc.createPart({ partId: 'G2' });
    await svc.declareVariant('G2', { parentId: 'G1' }); // G1 无数据 → 沿链取 G0
    await recordExact(svc, 'G2', 100, 0.7, [10]);
    const fit = await svc.getFit('G2');
    // G1 无自身拟合，但其先验来自 G0（0.9），故 G2 的先验均值≈0.9
    expect(Math.abs(fit.learningRate! - 0.9)).toBeLessThan(1e-6);
  });
});
