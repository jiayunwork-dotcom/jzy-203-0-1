/**
 * 投影：把部件的事件流折叠成当前状态。
 *
 * 关键设计：批次的累计区间不存储，而是由"生产顺序 + 各批件数 + 跳号"
 * 在投影时派生。因此更正某批件数后，后续所有批次的区间会自动整体平移；
 * 作废某批同理。跳号（gap）以"本批之前跳过的件数"记录，平移时间隙大小不变。
 *
 * 本模块为纯函数，当前态快照与历史时点回推共用同一套逻辑，保证一致。
 */

export interface BatchState {
  batchId: string;
  quantity: number;
  hours: number;
  /** 本批之前跳过的件数（跳号），录入时由服务端根据当时游标换算 */
  gap: number;
  /** 派生：本批第一件序号 */
  firstUnit: number;
  /** 派生：本批最后一件序号 */
  lastUnit: number;
}

export interface PartProjection {
  partId: string;
  exists: boolean;
  name: string | null;
  parentId: string | null;
  priorStrength: number | null;
  explicitPriorLr: number | null;
  /** 有效批次，按生产顺序（录入事件的顺序） */
  batches: BatchState[];
  /** 下一件的序号 */
  nextUnit: number;
  /** 出现过的所有 batchId（含已作废），用于禁止复用 */
  seenBatchIds: string[];
}

export interface DomainEvent {
  type: string;
  payload: Record<string, unknown>;
}

export function emptyProjection(partId: string): PartProjection {
  return {
    partId,
    exists: false,
    name: null,
    parentId: null,
    priorStrength: null,
    explicitPriorLr: null,
    batches: [],
    nextUnit: 1,
    seenBatchIds: [],
  };
}

/** 重新派生所有批次的区间与 nextUnit */
function recompute(proj: PartProjection): void {
  let cursor = 1;
  for (const b of proj.batches) {
    b.firstUnit = cursor + b.gap;
    b.lastUnit = b.firstUnit + b.quantity - 1;
    cursor = b.lastUnit + 1;
  }
  proj.nextUnit = cursor;
}

/** 应用一条事件（就地修改并返回同一对象）。 */
export function applyEvent(proj: PartProjection, event: DomainEvent): PartProjection {
  const p = event.payload as Record<string, any>;
  switch (event.type) {
    case 'part_registered':
      proj.exists = true;
      proj.name = (p.name as string) ?? null;
      break;
    case 'variant_declared':
      proj.parentId = p.parentId as string;
      proj.priorStrength = p.priorStrength as number;
      proj.explicitPriorLr = (p.explicitPriorLr as number) ?? null;
      break;
    case 'batch_recorded': {
      proj.batches.push({
        batchId: p.batchId as string,
        quantity: p.quantity as number,
        hours: p.hours as number,
        gap: (p.gap as number) ?? 0,
        firstUnit: 0,
        lastUnit: 0,
      });
      if (!proj.seenBatchIds.includes(p.batchId as string)) {
        proj.seenBatchIds.push(p.batchId as string);
      }
      recompute(proj);
      break;
    }
    case 'batch_corrected': {
      const b = proj.batches.find((x) => x.batchId === p.batchId);
      if (b) {
        if (p.quantity != null) b.quantity = p.quantity as number;
        if (p.hours != null) b.hours = p.hours as number;
        recompute(proj);
      }
      break;
    }
    case 'batch_voided': {
      const i = proj.batches.findIndex((x) => x.batchId === p.batchId);
      if (i >= 0) {
        proj.batches.splice(i, 1);
        recompute(proj);
      }
      break;
    }
    default:
      break;
  }
  return proj;
}

/** 从事件序列重放投影（历史时点回推与重启恢复共用）。 */
export function replayEvents(partId: string, events: DomainEvent[]): PartProjection {
  const proj = emptyProjection(partId);
  for (const e of events) applyEvent(proj, e);
  return proj;
}
