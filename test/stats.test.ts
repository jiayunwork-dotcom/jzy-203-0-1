/**
 * 数值统计例程的正确性（对照文献值）。
 */
import { logGamma, regularizedIncompleteBeta, tCdf, tQuantile } from '../src/stats';

test('logGamma 已知值', () => {
  expect(logGamma(1)).toBeCloseTo(0, 10);
  expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
  expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
});

test('正则化不完全 Beta 函数已知值', () => {
  expect(regularizedIncompleteBeta(0.5, 1, 1)).toBeCloseTo(0.5, 12);
  expect(regularizedIncompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 12);
  expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
});

test('t 分布 0.975 分位数与文献值一致', () => {
  expect(tQuantile(0.975, 1)).toBeCloseTo(12.7062, 3);
  expect(tQuantile(0.975, 2)).toBeCloseTo(4.3027, 3);
  expect(tQuantile(0.975, 10)).toBeCloseTo(2.2281, 3);
  expect(tQuantile(0.975, 30)).toBeCloseTo(2.0423, 3);
  expect(tQuantile(0.975, 1000)).toBeCloseTo(1.9623, 3);
});

test('tCdf 与 tQuantile 互逆', () => {
  for (const df of [1, 2, 5, 30]) {
    expect(tCdf(tQuantile(0.975, df), df)).toBeCloseTo(0.975, 8);
  }
});
