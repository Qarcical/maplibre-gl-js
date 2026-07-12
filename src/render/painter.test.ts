import {describe, beforeEach, test, expect, vi} from 'vitest';
import {Painter} from './painter';
import {MercatorTransform} from '../geo/projection/mercator_transform';
import {Style} from '../style/style';
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
