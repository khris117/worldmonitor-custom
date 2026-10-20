// Desktop gated these features on local API keys, but the sidecar always sends
// their routes to the cloud, where no local key is read: a keyless desktop gets a
// 401 there, and a signed-in Pro desktop gets data. The Internet Outages layer
// vanished on any desktop without a Cloudflare token, even though the public
// bootstrap had already delivered its data (#5829).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime')>(),
  isDesktopRuntime: () => true,
}));

const vaultKeys = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('@/services/tauri-bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/tauri-bridge')>(),
  invokeTauri: async (command: string) => (command === 'list_configured_secret_keys' ? vaultKeys.list : null),
}));

const hydration = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/bootstrap')>(),
  getHydratedData: (key: string) => {
    const value = hydration.get(key);
    hydration.delete(key);
    return value;
  },
}));

const CLOUD_SERVED = ['internetOutages', 'energyEia', 'wtoTrade', 'supplyChain', 'economicFred'] as const;

describe('desktop features served by the cloud', () => {
  beforeEach(async () => {
    vi.resetModules();
    hydration.clear();
    vaultKeys.list = [];
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  });

  it('stay gated without a Pro cloud session', async () => {
    const { isFeatureAvailable } = await import('@/services/runtime-config');
    for (const feature of CLOUD_SERVED) expect(isFeatureAvailable(feature), feature).toBe(false);
  });

  it('ignore local vendor keys, which never reach a cloud-routed endpoint', async () => {
    vaultKeys.list = ['CLOUDFLARE_API_TOKEN', 'EIA_API_KEY', 'WTO_API_KEY', 'FRED_API_KEY'];
    const { isFeatureAvailable, loadDesktopSecrets } = await import('@/services/runtime-config');
    await loadDesktopSecrets();
    for (const feature of CLOUD_SERVED) expect(isFeatureAvailable(feature), feature).toBe(false);
  });

  it('are available with a WorldMonitor API key, which the sidecar forwards to the cloud', async () => {
    vaultKeys.list = ['WORLDMONITOR_API_KEY'];
    const { isFeatureAvailable, loadDesktopSecrets } = await import('@/services/runtime-config');
    await loadDesktopSecrets();
    for (const feature of CLOUD_SERVED) expect(isFeatureAvailable(feature), feature).toBe(true);
  });

  it('are available with a Pro cloud session and no local key', async () => {
    const { isFeatureAvailable, setDesktopCloudSessionProbe } = await import('@/services/runtime-config');
    setDesktopCloudSessionProbe(() => true);
    for (const feature of CLOUD_SERVED) expect(isFeatureAvailable(feature), feature).toBe(true);
    // Wingbits runs locally and calls the vendor with the user's own key.
    expect(isFeatureAvailable('wingbitsEnrichment')).toBe(false);
  });

  it('keeps the bootstrap outage snapshot on a desktop without cloud access', async () => {
    hydration.set('outages', {
      outages: [{ id: 'o1', title: 'Outage', link: '', description: '', country: 'IR', region: '', severity: 'OUTAGE_SEVERITY_MAJOR', categories: [], location: { latitude: 32, longitude: 53 }, detectedAt: Date.now(), cause: '', outageType: '' }],
    });
    const { fetchInternetOutages, isOutagesConfigured } = await import('@/services/infrastructure');
    expect(await fetchInternetOutages()).toHaveLength(1);
    expect(isOutagesConfigured()).toBe(true);
    // The refresh cannot reach the cloud, so it keeps the snapshot instead of hiding the layer.
    expect(await fetchInternetOutages()).toHaveLength(1);
    expect(isOutagesConfigured()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hides the outage layer when there is neither a snapshot nor cloud access', async () => {
    const { fetchInternetOutages, isOutagesConfigured } = await import('@/services/infrastructure');
    expect(await fetchInternetOutages()).toEqual([]);
    expect(isOutagesConfigured()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops shipping data when the user turned supply chain off', async () => {
    hydration.set('shippingRates', { indices: [{ indexId: 'BDI', name: 'Baltic Dry', currentValue: 1500 }] });
    const { setFeatureToggle } = await import('@/services/runtime-config');
    setFeatureToggle('supplyChain', false);
    const { fetchShippingRates } = await import('@/services/supply-chain');
    expect((await fetchShippingRates()).indices).toEqual([]);
  });

  it('keeps the bootstrap shipping-rate snapshot without calling the cloud', async () => {
    hydration.set('shippingRates', { indices: [{ indexId: 'BDI', name: 'Baltic Dry', currentValue: 1500 }] });
    const { fetchShippingRates } = await import('@/services/supply-chain');
    expect((await fetchShippingRates()).indices).toHaveLength(1);
    // Past the breaker's one-hour cache, a refresh would otherwise go to the cloud and 401.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    try {
      expect((await fetchShippingRates()).indices).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    // A stale breaker refreshes in the background; give that refresh a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).not.toHaveBeenCalled();
  });
});
