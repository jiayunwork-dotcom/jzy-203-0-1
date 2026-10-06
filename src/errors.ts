/**
 * 领域错误类型：code 用于 API 错误响应，status 为对应 HTTP 状态码。
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 请求体/参数不合法（件数非正整数、工时不为正、先验越界等） → 400 */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION', message, 400);
  }
}

/** 部件/批次/继承关系不存在 → 404 */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('NOT_FOUND', message, 404);
  }
}

/** 领域不变量冲突（区间重叠/空档、批次号重复、继承成环、事件编号重用等） → 409 */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

/** 数据不足以拟合（批次为空，或仅一批且无先验） → 422 */
export class InsufficientDataError extends DomainError {
  constructor(message: string) {
    super('INSUFFICIENT_DATA', message, 422);
  }
}

/** 代表件不动点迭代未收敛（正常数据不会发生） → 500 */
export class ConvergenceError extends DomainError {
  constructor(message: string) {
    super('CONVERGENCE', message, 500);
  }
}
