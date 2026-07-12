import {describe, expect, test} from 'vitest';
import {UploadScheduler} from './upload_scheduler';

describe('UploadScheduler', () => {
    test('budget floors at 1ms when there is no headroom', () => {
        const s = new UploadScheduler();
        // saturate the base-cost EMA at the whole frame period
        for (let i = 0; i < 50; i++) s.onFrameEnd(16.7);
        s.onFrameStart(16.7);
        expect(s.budgetMs).toBeCloseTo(1.0, 5);
    });

    test('budget takes half the measured headroom', () => {
        const s = new UploadScheduler();
        for (let i = 0; i < 100; i++) s.onFrameEnd(4);   // base cost settles to ~4ms
        s.onFrameStart(16.7);
        expect(s.budgetMs).toBeGreaterThan(5);           // ~ (16.7 - 4) / 2 ≈ 6.35
        expect(s.budgetMs).toBeLessThan(7);
    });

    test('budget never exceeds the frame period', () => {
        const s = new UploadScheduler();
        for (let i = 0; i < 100; i++) s.onFrameEnd(0.5);
        s.onFrameStart(8.3);                             // 120Hz
        expect(s.budgetMs).toBeLessThanOrEqual(8.3);
    });

    test('per-frame budget scales with the frame period (drain per second is rate-independent)', () => {
        const s = new UploadScheduler();
        for (let i = 0; i < 100; i++) s.onFrameEnd(4);
        s.onFrameStart(16.7);
        const at60 = s.budgetMs;
        s.onFrameStart(33.3);                            // governor demoted to 30fps
        const at30 = s.budgetMs;
        expect(at30).toBeGreaterThan(at60 * 1.8);        // ~2× per frame at half the frames
    });

    test('a deep backlog scales the budget up', () => {
        const s = new UploadScheduler();
        for (let i = 0; i < 100; i++) s.onFrameEnd(12);
        s.onFrameStart(16.7);
        const noBacklog = s.budgetMs;
        for (let i = 0; i < 64; i++) s.noteDeferred();   // 64 tiles left waiting
        s.onFrameStart(16.7);
        expect(s.budgetMs).toBeGreaterThan(noBacklog * 2);
    });

    test('greedy spend: grants stop once the budget is spent', () => {
        const s = new UploadScheduler();
        s.onFrameStart(16.7);                            // no EMA yet → budget from half-period seed
        expect(s.hasBudget()).toBe(true);
        s.noteGranted(100);                              // one huge tile blows the budget
        expect(s.hasBudget()).toBe(false);
        expect(s.granted).toBe(1);
    });

    test('upload time is subtracted from the base-cost EMA (draining cannot eat its own headroom)', () => {
        const spreading = new UploadScheduler();
        const idle = new UploadScheduler();
        for (let i = 0; i < 100; i++) {
            spreading.onFrameStart(16.7);
            spreading.noteGranted(6);                    // 6ms of uploads every frame...
            spreading.onFrameEnd(10);                    // ...inside a 10ms frame
            idle.onFrameStart(16.7);
            idle.onFrameEnd(4);                          // same 4ms base cost, no uploads
        }
        spreading.onFrameStart(16.7);
        idle.onFrameStart(16.7);
        expect(spreading.budgetMs).toBeCloseTo(idle.budgetMs, 1);
    });

    test('external uploads (DEM textures) debit the next frame', () => {
        const s = new UploadScheduler();
        s.onFrameStart(16.7);
        const budget = s.budgetMs;
        s.noteExternalUpload(budget + 1);
        s.onFrameStart(16.7);
        expect(s.hasBudget()).toBe(false);               // fully debited...
        s.onFrameStart(16.7);
        expect(s.hasBudget()).toBe(true);                // ...but consumed once, not carried forever
    });

    test('updateVolatileSources collects sources with the rtt-stack-break metadata', () => {
        const s = new UploadScheduler();
        s.updateVolatileSources({
            _order: ['a', 'b', 'c'],
            _layers: {
                a: {source: 'anim-delta', metadata: {'map2:rtt-stack-break': true}},
                b: {source: 'basemap', metadata: {}},
                c: {source: 'goals'},
            },
        });
        expect(s.volatileSources.has('anim-delta')).toBe(true);
        expect(s.volatileSources.has('basemap')).toBe(false);
        expect(s.volatileSources.has('goals')).toBe(false);
    });
});
