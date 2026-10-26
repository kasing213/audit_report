import test from 'node:test';
import assert from 'node:assert/strict';
import { routePaste, describeChat } from '../../src/bot/routing';
import { HelpCommand } from '../../src/bot/commands/help-command';

// ── Where a paste goes ──

test('closing group takes Close-sell', () => {
  assert.equal(routePaste('closeSell', 'closing', true), 'accept');
});

test('closing group turns a Bulk report away', () => {
  assert.equal(routePaste('bulk', 'closing', true), 'wrongGroup');
});

test('with a closing group set, the sales group turns Close-sell away', () => {
  assert.equal(routePaste('closeSell', 'sales', true), 'wrongGroup');
});

test('the sales group keeps Bulk', () => {
  assert.equal(routePaste('bulk', 'sales', true), 'accept');
  assert.equal(routePaste('bulk', 'sales', false), 'accept');
});

test('until a closing group is set, the sales group still takes Close-sell', () => {
  assert.equal(routePaste('closeSell', 'sales', false), 'accept');
});

test('summary and audit chats keep taking both', () => {
  for (const role of ['summary', 'audit'] as const) {
    assert.equal(routePaste('bulk', role, true), 'accept');
    assert.equal(routePaste('closeSell', role, true), 'accept');
  }
});

test('any other chat is ignored', () => {
  assert.equal(routePaste('bulk', null, true), 'ignore');
  assert.equal(routePaste('closeSell', null, true), 'ignore');
});

// ── /start shows the chat ID ──

test('/start in a new group shows its negative chat ID and that it is not set up', () => {
  const text = describeChat({ id: -1004555666777, title: 'Closing', type: 'supergroup' }, null);
  assert.match(text, /-1004555666777/);
  assert.match(text, /CLOSING_GROUP_CHAT_ID/);
});

test('/start in the closing group says it is the closing group', () => {
  const text = describeChat({ id: -1004555666777, title: 'Closing', type: 'supergroup' }, 'closing');
  assert.match(text, /-1004555666777/);
  assert.match(text, /Close sell/i);
});

// ── /help sends each group only its own template ──


test('/help in the closing group sends only the Close-sell template', async () => {
  const sent: string[] = [];
  const ctx = { from: { id: 1 }, chat: { id: -1 }, reply: async (t: string) => { sent.push(t); } } as any;
  await new HelpCommand().handleCommand(ctx, 'closing', true);
  assert.ok(sent.some(t => t.startsWith('💯Close sell')));
  assert.ok(!sent.some(t => t.includes('Tel1=')));
});

test('/help in the sales group drops the Close-sell template once a closing group is set', async () => {
  const sent: string[] = [];
  const ctx = { from: { id: 1 }, chat: { id: -1 }, reply: async (t: string) => { sent.push(t); } } as any;
  await new HelpCommand().handleCommand(ctx, 'sales', true);
  assert.ok(sent.some(t => t.includes('Tel1=')));
  assert.ok(!sent.some(t => t.startsWith('💯Close sell')));
});

test('/help in the sales group keeps both templates while no closing group is set', async () => {
  const sent: string[] = [];
  const ctx = { from: { id: 1 }, chat: { id: -1 }, reply: async (t: string) => { sent.push(t); } } as any;
  await new HelpCommand().handleCommand(ctx, 'sales', false);
  assert.ok(sent.some(t => t.includes('Tel1=')));
  assert.ok(sent.some(t => t.startsWith('💯Close sell')));
});

