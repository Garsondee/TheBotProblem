/**
 * Runs before every test file.
 *
 * Money rule 1 says: "Never call a paid API to test code." This file makes that
 * impossible to do by accident. Any test that reaches for the network — directly,
 * or through the Anthropic SDK, which uses `fetch` under the hood — fails loudly
 * instead of quietly spending credit. Tests that need HTTP pass in a fake `fetch`.
 */
import { beforeEach } from 'vitest';

const blockedFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Network access is blocked in tests (tried to fetch ${url}). Pass a fake fetch instead.`);
};

beforeEach(() => {
  // Re-applied before every test, so a test that swaps in its own fake
  // cannot leave the real network switched on for the tests after it.
  globalThis.fetch = blockedFetch;
});
