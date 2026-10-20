// Desktop features that need no local key (#5829) are only correct while the
// sidecar sends their routes to the cloud and the gateway serves those routes
// to a keyless desktop. If either changes, the layer or panel goes empty again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { __testing__ } from '../src-tauri/sidecar/local-api-server.mjs';

const root = resolve(import.meta.dirname, '..');
const gateway = readFileSync(resolve(root, 'server/gateway.ts'), 'utf8');
const runtimeConfig = readFileSync(resolve(root, 'src/services/runtime-config.ts'), 'utf8');

const CLOUD_ROUTED = {
  internetOutages: ['/api/infrastructure/v1/list-internet-outages'],
  energyEia: [
    '/api/economic/v1/get-energy-prices',
    '/api/economic/v1/get-crude-inventories',
    '/api/economic/v1/get-nat-gas-storage',
    '/api/economic/v1/get-energy-capacity',
  ],
  wtoTrade: [
    '/api/trade/v1/get-trade-restrictions',
    '/api/trade/v1/get-trade-flows',
    '/api/trade/v1/get-trade-barriers',
  ],
  supplyChain: ['/api/supply-chain/v1/get-shipping-rates'],
};

describe('desktop features that need no local key', () => {
  for (const [feature, routes] of Object.entries(CLOUD_ROUTED)) {
    it(`${feature} is cloud-routed and public`, () => {
      for (const route of routes) {
        assert.equal(__testing__.isCloudPreferred(route), true, `${route} is cloud-routed`);
        assert.ok(gateway.includes(`'${route}'`), `${route} is public at the gateway`);
      }
    });
  }

  it('matches the features runtime-config un-gates on desktop', () => {
    const ungated = [...runtimeConfig.matchAll(/id: '(\w+)'[^}]*?desktopRequiredSecrets: \[\]/g)].map((m) => m[1]);
    assert.deepEqual(ungated.sort(), Object.keys(CLOUD_ROUTED).sort());
  });
});
