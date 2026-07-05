import { test, expect } from "bun:test";
import { IterationBudget } from "../../src/agent/iteration-budget.ts";

test("IterationBudget allows up to maxTotal calls", () => {
  const budget = new IterationBudget(5);
  expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(true);
  expect(budget.consume()).toBe(false);
});

test("IterationBudget tracks remaining correctly", () => {
  const budget = new IterationBudget(3);
  expect(budget.remaining).toBe(3);
  budget.consume();
  expect(budget.remaining).toBe(2);
  budget.consume();
  expect(budget.remaining).toBe(1);
  budget.consume();
  expect(budget.remaining).toBe(0);
  budget.consume();
  expect(budget.remaining).toBe(0);
});

test("IterationBudget tracks used correctly", () => {
  const budget = new IterationBudget(4);
  expect(budget.total).toBe(4);
  budget.consume();
  expect(budget.total).toBe(4);
  budget.consume();
  budget.consume();
  expect(budget.total).toBe(4);
});

test("IterationBudget with zero maxTotal never allows", () => {
  const budget = new IterationBudget(0);
  expect(budget.consume()).toBe(false);
  expect(budget.remaining).toBe(0);
});

test("IterationBudget grant extends the budget", () => {
  const budget = new IterationBudget(2);
  budget.consume();
  budget.consume();
  expect(budget.consume()).toBe(false);
  budget.grant(3);
  expect(budget.total).toBe(5);
  expect(budget.remaining).toBe(3);
  expect(budget.consume()).toBe(true);
});
