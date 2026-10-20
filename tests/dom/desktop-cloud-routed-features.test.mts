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
  invokeTauri: async (command: string) => {
    if (command === 'list_configured_secret_keys') return vaultKeys.list;
    throw new Error('Tauri invoke bridge unavailable');
  },
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

  it('restores a persisted outage snapshot on a fresh launch without bootstrap or cloud access', async () => {
    hydration.set('outages', {
      outages: [{ id: 'o1', title: 'Outage', link: '', description: '', country: 'IR', region: '', severity: 'OUTAGE_SEVERITY_MAJOR', categories: [], location: { latitude: 32, longitude: 53 }, detectedAt: Date.now(), cause: '', outageType: '' }],
    });
    const first = await import('@/services/infrastructure');
    expect(await first.fetchInternetOutages()).toHaveLength(1);
    // Let the breaker's persistent write land, then start over as a new process would.
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.resetModules();
    const relaunched = await import('@/services/infrastructure');
    expect(await relaunched.fetchInternetOutages()).toHaveLength(1);
    expect(relaunched.isOutagesConfigured()).toBe(true);
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

  it('clears shipping indices from the panel when the user turns supply chain off', async () => {
    const { SupplyChainPanel } = await import('@/components/SupplyChainPanel');
    const { setFeatureToggle } = await import('@/services/runtime-config');
    const panel = new SupplyChainPanel();
    panel.updateShippingRates({ indices: [{ indexId: 'PCU483111483111', name: 'Deep Sea Freight PPI', currentValue: 1500, previousValue: 1400, changePct: 7, unit: 'pts', history: [], spikeAlert: false }], fetchedAt: '', upstreamUnavailable: false });
    await vi.waitFor(() => expect(panel.getElement().querySelector('.panel-tab[data-tab="indicators"]')).not.toBeNull());
    panel.getElement().querySelector<HTMLElement>('.panel-tab[data-tab="indicators"]')!.click();
    await vi.waitFor(() => expect(panel.getElement().textContent).toContain('Deep Sea Freight PPI'));
    setFeatureToggle('supplyChain', false);
    await vi.waitFor(() => expect(panel.getElement().textContent).not.toContain('Deep Sea Freight PPI'), { timeout: 500 });
    panel.destroy();
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
