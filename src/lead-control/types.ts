/** All Lead Control money values are integer USD cents. */
export type UsdCents = number;

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
  netBookings: number;
}

export type LeadControlStatus = 'Good' | 'Bad' | 'Pending';
