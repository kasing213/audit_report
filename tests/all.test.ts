// Single entry point for the suite: `npm test` loads this file, which imports
// every test module in dependency order. Keeps the runner invocation to one
// path and makes the ts-node register shim load exactly once.
import './payment-tracker/org-boundary.test';
import './payment-tracker/payment-domain.test';
import './payment-tracker/payment-source.test';
import './payment-tracker/payment-template.test';
import './payment-tracker/payment-proposal.test';
import './payment-tracker/payment-scanner.test';
