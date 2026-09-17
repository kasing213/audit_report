import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetForNetBookings,
  classifyCancellationRate,
  classifyCostPerResult,
  classifyOutcome,
  costPerResultCents,
  forecastFromBudget,
  formatBudgetToMessages,
  formatOneDecimal,
  formatPercentOneDecimal,
  proratedMonthlyBudgetCents,
  rate,
} from '../../src/lead-control/forecast';

const funnel = {
  costPerMessageCents: 150,
  messageToPhoneRate: 0.5,
  phoneToVisitRate: 0.5,
  visitToBookingRate: 0.5,
  cancellationRate: 0.2,
};

test('forecasts every funnel stage from an integer-cent budget', () => {
  const forecast = forecastFromBudget({ budgetCents: 10000, ...funnel });

  assert.equal(forecast.messages, 10000 / 150);
  assert.equal(forecast.phoneLeads, 10000 / 150 * 0.5);
  assert.equal(forecast.visits, 10000 / 150 * 0.5 * 0.5);
  assert.equal(forecast.grossBookings, 10000 / 150 * 0.5 * 0.5 * 0.5);
  assert.equal(forecast.netBookings, 10000 / 150 * 0.5 * 0.5 * 0.5 * 0.8);
});

test('formats the budget-to-message calculation as $100 / $1.50 = 66.7 messages', () => {
  assert.equal(formatBudgetToMessages(10000, 150), '$100 / $1.50 = 66.7 messages');
});

test('calculates the smallest cent budget needed for a net-booking target', () => {
  assert.equal(budgetForNetBookings({ targetNetBookings: 10, ...funnel }), 15000);
  assert.equal(budgetForNetBookings({ targetNetBookings: 1, ...funnel }), 1500);
});

test('rejects invalid money, conversion, and target inputs', () => {
  assert.throws(() => forecastFromBudget({ budgetCents: 100.5, ...funnel }), /budgetCents/);
  assert.throws(() => forecastFromBudget({ budgetCents: 10000, ...funnel, costPerMessageCents: 0 }), /costPerMessageCents/);
  assert.throws(() => forecastFromBudget({ budgetCents: 10000, ...funnel, phoneToVisitRate: 1.01 }), /phoneToVisitRate/);
  assert.throws(() => budgetForNetBookings({ targetNetBookings: 1, ...funnel, cancellationRate: 1 }), /net booking/);
});

test('renders counts and rates with one decimal place', () => {
  assert.equal(formatOneDecimal(66.666), '66.7');
  assert.equal(formatPercentOneDecimal(2 / 3), '66.7%');
});

test('prorates a monthly cent budget across active calendar days', () => {
  assert.equal(proratedMonthlyBudgetCents(310000, 10, 31), 100000);
  assert.equal(proratedMonthlyBudgetCents(310000, 0, 31), 0);
  assert.throws(() => proratedMonthlyBudgetCents(10000, 32, 31), /activeDays/);
});

test('returns null instead of dividing by zero', () => {
  assert.equal(costPerResultCents(10000, 0), null);
  assert.equal(rate(1, 0), null);
});

test('classifies outcome achievement directly', () => {
  assert.equal(classifyOutcome(10, 10), 'Good');
  assert.equal(classifyOutcome(9, 10), 'Bad');
  assert.equal(classifyOutcome(null, 10), 'Pending');
});

test('classifies cost per result directly', () => {
  assert.equal(classifyCostPerResult(150, 150), 'Good');
  assert.equal(classifyCostPerResult(151, 150), 'Bad');
  assert.equal(classifyCostPerResult(null, 150), 'Pending');
});

test('classifies cancellation rate directly', () => {
  assert.equal(classifyCancellationRate(0.2, 0.2), 'Good');
  assert.equal(classifyCancellationRate(0.21, 0.2), 'Bad');
  assert.equal(classifyCancellationRate(null, 0.2), 'Pending');
});
