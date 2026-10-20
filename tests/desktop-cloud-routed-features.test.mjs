// A desktop feature marked `desktopCloudServed` is gated on the Pro cloud
// session instead of a local key (#5829). That is only right while the sidecar
// sends every one of its routes to the cloud, where no local key is read. If a
// route starts running locally, its key matters again and the flag must go.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { __testing__ } from '../src-tauri/sidecar/local-api-server.mjs';

const runtimeConfig = readFileSync(resolve(import.meta.dirname, '../src/services/runtime-config.ts'), 'utf8');

const CLOUD_SERVED_ROUTES = {
  internetOutages: ['/api/infrastructure/v1/list-internet-outages'],
  energyEia: [
    '/api/economic/v1/get-energy-prices',
    '/api/economic/v1/get-crude-inventories',
    '/api/economic/v1/get-nat-gas-storage',
    '/api/economic/v1/get-energy-capacity',
  ],
  wtoTrade: [
    '/api/trade/v1/get-trade-restrictions',
    '/api/trade/v1/get-tariff-trends',
    '/api/trade/v1/get-trade-flows',
    '/api/trade/v1/get-trade-barriers',
  ],
  supplyChain: ['/api/supply-chain/v1/get-shipping-rates'],
  economicFred: ['/api/economic/v1/get-fred-series-batch', '/api/economic/v1/get-fred-series'],
};

describe('desktop cloud-served features', () => {
  for (const [feature, routes] of Object.entries(CLOUD_SERVED_ROUTES)) {
    it(`${feature} runs only through cloud-routed endpoints`, () => {
      for (const route of routes) {
        assert.equal(__testing__.isCloudPreferred(route), true, `${route} is cloud-routed`);
      }
    });
  }

  it('lists exactly the features runtime-config marks as cloud-served', () => {
    const marked = [...runtimeConfig.matchAll(/id: '(\w+)'[^}]*?desktopCloudServed: true/g)].map((m) => m[1]);
    assert.deepEqual(marked.sort(), Object.keys(CLOUD_SERVED_ROUTES).sort());
  });
});
