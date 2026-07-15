import {describe, beforeEach, test, expect, vi} from 'vitest';
import {Painter} from './painter';
import {MercatorTransform} from '../geo/projection/mercator_transform';
import {Style} from '../style/style';
import {createStyleLayer} from '../style/create_style_layer';
import {StubMap} from '../util/test/util';
import {Texture} from '../webgl/texture';

describe('render', () => {
    let painter: Painter;
    let map: any;
    let style: Style;
    const renderOptions = {
        fadeDuration: 0,
        moving: false,
        rotating: false,
        showOverdrawInspector: false,
        showPadding: false,
        showTileBoundaries: false,
        zooming: false,
        anisotropicFilterPitch: 20,
    };

    beforeEach(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        transform.resize(512, 512);
        painter = new Painter(gl, transform);
        map = new StubMap() as any;
        style = new Style(map);
        style._setProjectionInternal('mercator');
        style._updatePlacement(transform, false, 0, false);
    });

    test('must not fail with incompletely loaded style', () => {
        painter.render(style, renderOptions);
    });

    test('calls terrainDepth but not terrainCoords', () => {
        const terrainDepth = vi.spyOn(painter.drawFunctions, 'terrainDepth').mockImplementation(() => {});
        const terrainCoords = vi.spyOn(painter.drawFunctions, 'terrainCoords').mockImplementation(() => {});
        map.terrain = {tileManager: {anyTilesAfterTime: () => false}};

        painter.render(style, renderOptions);

        expect(terrainDepth).toHaveBeenCalled();
        expect(terrainCoords).not.toHaveBeenCalled();
    });
});

describe('tile texture pool', () => {
    function createPainterWithPool() {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        return new Painter(gl, transform);
    }

    function createTexture(painter: Painter, size: number): Texture {
        const gl = painter.context.gl;
        const image = {width: size, height: size, data: new Uint8Array(size * size * 4)} as any;
        return new Texture(painter.context, image, gl.RGBA);
    }

    test('saveTileTexture caps pool size and destroys excess', () => {
        const painter = createPainterWithPool();
        const cap = Painter.MAX_TEXTURE_POOL_SIZE_PER_BUCKET;

        const textures: Texture[] = [];
        for (let i = 0; i < cap + 100; i++) {
            const tex = createTexture(painter, 256);
            textures.push(tex);
            painter.saveTileTexture(tex);
        }

        let reused = 0;
        while (painter.getTileTexture(256)) reused++;
        expect(reused).toBe(cap);

        const destroyed = textures.filter(t => t.texture === null).length;
        expect(destroyed).toBe(100);

        painter.destroy();
    });
});

// PATCH (map2-fork): the pool-object stash is byte-capped, not count-capped — stash
// residents are exactly the memory the iOS jetsam ceiling cares about, and the old
// count cap (96) allowed 1.6GB of 16.8MB full-tier objects in theory.
describe('pool stash byte cap', () => {
    function stubPair() {
        return {fbo: {destroy: vi.fn()} as any, texture: {destroy: vi.fn()} as any};
    }

    test('stash refuses past the byte budget, take releases bytes, trim enforces a lowered budget', () => {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        const painter = new Painter(gl, transform);
        const objectBytes = 512 * 512 * 4;
        painter._poolStashMaxBytes = objectBytes * 2;

        const [a, b, c] = [stubPair(), stubPair(), stubPair()];
        expect(painter.stashPoolObject(512, a.fbo, a.texture)).toBe(true);
        expect(painter.stashPoolObject(512, b.fbo, b.texture)).toBe(true);
        // budget full — the third object must be refused (caller destroys it)
        expect(painter.stashPoolObject(512, c.fbo, c.texture)).toBe(false);
        expect(painter._poolStashBytes).toBe(objectBytes * 2);

        // taking an entry releases its bytes
        expect(painter.takePoolStash(512)).not.toBeNull();
        expect(painter._poolStashBytes).toBe(objectBytes);
        expect(painter.stashPoolObject(512, c.fbo, c.texture)).toBe(true);

        // lowering the budget trims (newest first) and destroys what it evicts
        painter._poolStashMaxBytes = objectBytes;
        painter.trimPoolStash();
        expect(painter._poolStashBytes).toBe(objectBytes);
        expect(painter._poolStash).toHaveLength(1);
        expect(c.texture.destroy).toHaveBeenCalled();
    });
});

// PATCH (map2-fork): idle-time terrain shader warm-up — record 2D compiles, then
// pre-compile their /terrain twins (plus the pure terrain programs) one at a time
// so the first terrain frame finds a warm cache (see Map#precompileTerrainPrograms).
describe('terrain shader warm-up', () => {
    test('records 2D compiles and warms their terrain twins one per call', () => {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        transform.resize(512, 512);
        const painter = new Painter(gl, transform);
        const map = new StubMap() as any;
        const style = new Style(map);
        style._setProjectionInternal('mercator');
        painter.style = style;
        painter.context.gl.isContextLost = () => false;   // the mock GL reports lost

        // no recording by default: a 2D compile leaves no candidate
        painter.useProgram('fill');
        expect(painter._terrainWarmPending).toHaveLength(0);

        painter._terrainWarmRecording = true;
        painter.useProgram('fillOutline');
        expect(painter._terrainWarmPending).toHaveLength(1);
        // a cache hit records nothing
        painter.useProgram('fillOutline');
        expect(painter._terrainWarmPending).toHaveLength(1);

        // warm: pure terrain programs first, then the recorded twin, then dry
        const keysWithTerrain = () => Object.keys(painter.cache).filter(k => k.includes('/terrain'));
        expect(painter.warmTerrainProgram()).toBe(true);   // terrain
        expect(painter.warmTerrainProgram()).toBe(true);   // terrainDepth
        expect(painter.warmTerrainProgram()).toBe(true);   // terrainCoords
        expect(painter.warmTerrainProgram()).toBe(true);   // fillOutline twin
        expect(painter._terrainWarmPending).toHaveLength(0);
        expect(keysWithTerrain().some(k => k.startsWith('fillOutline'))).toBe(true);
        expect(painter.warmTerrainProgram()).toBe(false);  // everything warm

        // the warmed twin is a cache HIT for the terrain render path
        map.terrain = {};
        const {compiled} = painter._getOrCompileProgram('fillOutline', null, true, false, []);
        expect(compiled).toBe(false);
    });
});

// PATCH (map2-fork): style-derived warm seeding — recording 2D compiles can't see
// variants that only ever draw in 3D (photo symbols, anim overlays), so their program
// name + configuration is derived from the style declarations instead and queued for
// the same idle/burst drain (see Map#seedTerrainProgramsFromStyle).
describe('style-derived terrain warm seeding', () => {
    function createPainterWithStyle() {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        transform.resize(512, 512);
        const painter = new Painter(gl, transform);
        const style = new Style(new StubMap() as any);
        style._setProjectionInternal('mercator');
        painter.style = style;
        painter.context.gl.isContextLost = () => false;   // the mock GL reports lost
        return {painter, style};
    }

    test('seeds 3D-only variants from style declarations and drains them', () => {
        const {painter, style} = createPainterWithStyle();

        // an anim-track-like layer: data-driven color, lineMetrics GeoJSON source —
        // trim mode sets its line-gradient at runtime, AFTER any warm drain
        const animTrack = createStyleLayer({
            id: 'overlay-anim-track', type: 'line', source: 'anim-track',
            paint: {'line-color': ['match', ['get', 'mode'], 'walk', '#123456', '#654321'], 'line-width': 3}
        } as any, {});
        // a photo-symbol-like layer that only ever draws in 3D
        const photos = createStyleLayer({
            id: 'photos', type: 'symbol', source: 'photos',
            layout: {'icon-image': ['get', 'img']},
            paint: {'icon-halo-color': '#fff'}
        } as any, {});
        // layout-hidden layers MUST still seed: visibility is a runtime toggle, and the
        // anim overlays ship 'none' until anim enter (distinctive via dasharray → lineSDF)
        const hidden = createStyleLayer({
            id: 'hidden', type: 'line', source: 'other',
            layout: {visibility: 'none'},
            paint: {'line-dasharray': [2, 2]}
        } as any, {});
        for (const layer of [animTrack, photos, hidden]) {
            layer.recalculate({zoom: 10, zoomHistory: {}} as any, []);
        }
        style._order = ['overlay-anim-track', 'photos', 'hidden'];
        style._layers = {'overlay-anim-track': animTrack, photos, hidden} as any;
        style.getSource = ((id: string) =>
            id === 'anim-track' ? {workerOptions: {geojsonVtOptions: {lineMetrics: true}}} : undefined) as any;

        const seeded = painter.seedTerrainWarmFromStyle();
        expect(seeded).toBeGreaterThan(0);
        const names = painter._terrainWarmPending.map(c => c.name);
        expect(names).toContain('line');
        // the runtime trim gradient is anticipated via the source's lineMetrics
        expect(names).toContain('lineGradient');
        // icon SDF-ness is a bucket fact — both icon programs seed
        expect(names).toContain('symbolIcon');
        expect(names).toContain('symbolSDF');
        expect(names).toContain('clippingMask');
        // the hidden layer seeds too — visibility can flip at runtime
        expect(names).toContain('lineSDF');
        // the seeded configuration carries the data-driven binder layout
        const gradient = painter._terrainWarmPending.find(c => c.name === 'lineGradient');
        expect(gradient.configuration.cacheKey).toContain('/a_line-color');

        // the drain compiles the /terrain twins the recording path never saw
        while (painter.warmTerrainProgram()) {}
        const terrainKeys = Object.keys(painter.cache).filter(k => k.includes('/terrain'));
        expect(terrainKeys.some(k => k.startsWith('lineGradient') && k.includes('/a_line-color'))).toBe(true);
        expect(terrainKeys.some(k => k.startsWith('symbolSDF'))).toBe(true);
        expect(terrainKeys.some(k => k.startsWith('symbolIcon'))).toBe(true);

        // re-seeding is a no-op: every variant key is already known
        expect(painter.seedTerrainWarmFromStyle()).toBe(0);
        expect(painter._terrainWarmPending).toHaveLength(0);
    });
});
