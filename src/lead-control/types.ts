/** All Lead Control money values are integer USD cents. */
export type UsdCents = number;

/** A calculated cost in cents that may contain fractional cents and is never persisted as money. */
export type DerivedCostPerResultCents = number;

/** Conversion and cancellation rates are decimal values from zero through one. */
export interface FunnelRates {
  costPerMessageCents: UsdCents;
  messageToPhoneRate: number;
  phoneToVisitRate: number;
  visitToBookingRate: number;
  cancellationRate: number;
}

export interface BudgetForecastInput extends FunnelRates {
  budgetCents: UsdCents;
}

export interface NetBookingBudgetInput extends FunnelRates {
  targetNetBookings: number;
}

export interface FunnelForecast {
  messages: number;
  phoneLeads: number;
  visits: number;
  grossBookings: number;
  cancellations: number;
  netBookings: number;
}

export type LeadControlStatus = 'Good' | 'Bad' | 'Pending';

export type BudgetPacingState = 'Ahead' | 'On pace' | 'Behind';

export interface BudgetPacingInput {
  monthlyBudgetCents: UsdCents;
  activeDays: number;
  daysInMonth: number;
  actualSpendCents: UsdCents;
}

export interface BudgetPacing {
  plannedSpendCents: UsdCents;
  actualSpendCents: UsdCents;
  /** Actual minus planned spend; positive values are ahead of spend pace. */
  varianceCents: UsdCents;
  state: BudgetPacingState;
}
