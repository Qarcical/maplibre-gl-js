import {describe, test, expect} from 'vitest';
import {getHillshadeZoomAdjust} from './hillshade_program';

import type {Painter} from '../../render/painter';
import type {Tile} from '../../tile/tile';

// PATCH (map2-fork): the hillshade zoom adjust re-bases the prepared derivative from
// the intensity baked at the tile's integer zoom to the intensity for the continuous
// map covering zoom, so DEM LOD swaps don't step shading brightness (~2^0.3 per level).

function fakePainter(zoom: number, enabled: boolean = true): Painter {
    return {
        style: {map: {_hillshadeZoomAdjust: enabled}},
        transform: {zoom, tileSize: 512}
    } as any as Painter;
}

function fakeTile(overscaledZ: number, tileSize: number = 512): Tile {
    return {tileSize, tileID: {overscaledZ}} as any as Tile;
}

describe('getHillshadeZoomAdjust', () => {
    test('is 1 for a tile at exactly the covering zoom (matches stock)', () => {
        expect(getHillshadeZoomAdjust(fakePainter(12), fakeTile(12))).toBeCloseTo(1, 10);
    });

    test('dims a coarser parent tile to the covering-zoom intensity', () => {
        // stock renders a z11 tile 2^0.3 stronger than its z12 sibling; the adjust
        // cancels exactly that step
        const adjust = getHillshadeZoomAdjust(fakePainter(12), fakeTile(11));
        expect(adjust).toBeCloseTo(Math.pow(2, -0.3), 10);
    });

    test('parent and child of the same view differ by exactly one stock step', () => {
        const parent = getHillshadeZoomAdjust(fakePainter(12.4), fakeTile(11));
        const child = getHillshadeZoomAdjust(fakePainter(12.4), fakeTile(12));
        expect(parent / child).toBeCloseTo(Math.pow(2, -0.3), 10);
    });

    test('varies continuously with map zoom between integer levels', () => {
        const at12 = getHillshadeZoomAdjust(fakePainter(12), fakeTile(12));
        const at12_5 = getHillshadeZoomAdjust(fakePainter(12.5), fakeTile(12));
        const at13 = getHillshadeZoomAdjust(fakePainter(13), fakeTile(12));
        expect(at12_5).toBeGreaterThan(at13);
        expect(at12_5).toBeLessThan(at12);
        expect(at12_5).toBeCloseTo(Math.pow(2, -0.15), 10);
    });

    test('clamps the covering zoom to the source maxzoom (stock close-up look)', () => {
        // zoomed past the DEM ladder: every tile sits at maxzoom, adjust must be 1
        expect(getHillshadeZoomAdjust(fakePainter(14.7), fakeTile(12), 12)).toBeCloseTo(1, 10);
    });

    test('saturates above zoom 15 where stock has no exaggeration term', () => {
        expect(getHillshadeZoomAdjust(fakePainter(16.2), fakeTile(15))).toBeCloseTo(1, 10);
    });

    test('accounts for the source tileSize in the covering zoom', () => {
        // a 256px source covers at one deeper zoom than the 512-based transform zoom
        expect(getHillshadeZoomAdjust(fakePainter(12), fakeTile(13, 256))).toBeCloseTo(1, 10);
    });

    test('returns 1 when disabled via setHillshadeZoomAdjust(false)', () => {
        expect(getHillshadeZoomAdjust(fakePainter(12, false), fakeTile(9))).toBe(1);
    });
});
