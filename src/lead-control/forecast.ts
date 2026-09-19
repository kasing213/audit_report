import {
  BudgetForecastInput,
  BudgetPacing,
  BudgetPacingInput,
  DerivedCostPerResultCents,
  FunnelForecast,
  FunnelRates,
  LeadControlStatus,
  NetBookingBudgetInput,
  UsdCents,
} from './types';

export function forecastFromBudget(input: BudgetForecastInput): FunnelForecast {
  validateBudgetCents(input.budgetCents, 'budgetCents');
  validateFunnelRates(input);

  const messages = input.budgetCents / input.costPerMessageCents;
  const phoneLeads = messages * input.messageToPhoneRate;
  const visits = phoneLeads * input.phoneToVisitRate;
  const grossBookings = visits * input.visitToBookingRate;
  const cancellations = grossBookings * input.cancellationRate;

  return {
    messages,
    phoneLeads,
    visits,
    grossBookings,
    cancellations,
    netBookings: grossBookings - cancellations,
  };
}

export function budgetForNetBookings(input: NetBookingBudgetInput): UsdCents {
  validateNonNegativeNumber(input.targetNetBookings, 'targetNetBookings');
  validateFunnelRates(input);

  const netBookingsPerMessage =
    input.messageToPhoneRate *
    input.phoneToVisitRate *
    input.visitToBookingRate *
    (1 - input.cancellationRate);

  if (input.targetNetBookings > 0 && netBookingsPerMessage <= 0) {
    throw new RangeError('net booking conversion must be greater than zero');
  }

  return input.targetNetBookings === 0
    ? 0
    : Math.ceil(input.targetNetBookings / netBookingsPerMessage * input.costPerMessageCents);
}

export function formatBudgetToMessages(budgetCents: UsdCents, costPerMessageCents: UsdCents): string {
  validateBudgetCents(budgetCents, 'budgetCents');
  validatePositiveCents(costPerMessageCents, 'costPerMessageCents');
  return `${formatUsdCents(budgetCents)} / ${formatUsdCents(costPerMessageCents)} = ${formatOneDecimal(budgetCents / costPerMessageCents)} messages`;
}

export function formatOneDecimal(value: number): string {
  validateFiniteNumber(value, 'value');
  return value.toFixed(1);
}

export function formatPercentOneDecimal(rateValue: number): string {
  validateRate(rateValue, 'rateValue');
  return `${formatOneDecimal(rateValue * 100)}%`;
}

export function proratedMonthlyBudgetCents(
  monthlyBudgetCents: UsdCents,
  activeDays: number,
  daysInMonth: number,
): UsdCents {
  validateBudgetCents(monthlyBudgetCents, 'monthlyBudgetCents');
  validatePositiveInteger(daysInMonth, 'daysInMonth');
  validateNonNegativeInteger(activeDays, 'activeDays');
  if (activeDays > daysInMonth) throw new RangeError('activeDays cannot exceed daysInMonth');
  return Math.round(monthlyBudgetCents * activeDays / daysInMonth);
}

export function compareBudgetPacing(input: BudgetPacingInput): BudgetPacing {
  validateBudgetCents(input.actualSpendCents, 'actualSpendCents');
  const plannedSpendCents = proratedMonthlyBudgetCents(
    input.monthlyBudgetCents,
    input.activeDays,
    input.daysInMonth,
  );
  const varianceCents = input.actualSpendCents - plannedSpendCents;

  return {
    plannedSpendCents,
    actualSpendCents: input.actualSpendCents,
    varianceCents,
    state: varianceCents > 0 ? 'Ahead' : varianceCents < 0 ? 'Behind' : 'On pace',
  };
}

export function costPerResultCents(spendCents: UsdCents, results: number): DerivedCostPerResultCents | null {
  validateBudgetCents(spendCents, 'spendCents');
  validateNonNegativeNumber(results, 'results');
  return results === 0 ? null : spendCents / results;
}

export function rate(numerator: number, denominator: number): number | null {
  validateNonNegativeNumber(numerator, 'numerator');
  validateNonNegativeNumber(denominator, 'denominator');
  if (denominator === 0) return null;
  if (numerator > denominator) throw new RangeError('numerator cannot exceed denominator');
  return numerator / denominator;
}

export function classifyOutcome(actual: number | null, target: number): LeadControlStatus {
  validateNonNegativeNumber(target, 'target');
  if (actual === null) return 'Pending';
  validateNonNegativeNumber(actual, 'actual');
  return actual >= target ? 'Good' : 'Bad';
}

export function classifyCostPerResult(
  actualCents: DerivedCostPerResultCents | null,
  targetCents: DerivedCostPerResultCents,
): LeadControlStatus {
  validateNonNegativeNumber(targetCents, 'targetCents');
  if (actualCents === null) return 'Pending';
  validateNonNegativeNumber(actualCents, 'actualCents');
  return actualCents <= targetCents ? 'Good' : 'Bad';
}

export function classifyCancellationRate(actual: number | null, target: number): LeadControlStatus {
  validateRate(target, 'target');
  if (actual === null) return 'Pending';
  validateRate(actual, 'actual');
  return actual <= target ? 'Good' : 'Bad';
}

function validateFunnelRates(input: FunnelRates): void {
  validatePositiveCents(input.costPerMessageCents, 'costPerMessageCents');
  validateRate(input.messageToPhoneRate, 'messageToPhoneRate');
  validateRate(input.phoneToVisitRate, 'phoneToVisitRate');
  validateRate(input.visitToBookingRate, 'visitToBookingRate');
  validateRate(input.cancellationRate, 'cancellationRate');
}

function formatUsdCents(cents: UsdCents): string {
  validateBudgetCents(cents, 'cents');
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

function validateBudgetCents(value: number, name: string): void {
  validateNonNegativeInteger(value, name);
}

function validatePositiveCents(value: number, name: string): void {
  validatePositiveInteger(value, name);
}

function validateRate(value: number, name: string): void {
  validateFiniteNumber(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
}

function validateNonNegativeInteger(value: number, name: string): void {
  validateFiniteNumber(value, name);
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

function validatePositiveInteger(value: number, name: string): void {
  validateFiniteNumber(value, name);
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function validateNonNegativeNumber(value: number, name: string): void {
  validateFiniteNumber(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

function validateFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
