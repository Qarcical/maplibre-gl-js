import {describe, test, expect, vi} from 'vitest';
import {backfillDEM} from './tile_manager_raster_dem';
import {Tile} from './tile';
import {OverscaledTileID} from './tile_id';
import {InViewTiles} from './tile_manager_in_view_tiles';
import type {DEMData} from '../data/dem_data';

describe('backfillDEM', () => {

    test('do not backfill when no neighboring tiles information exists', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        backfillDEM(tile, new InViewTiles());

        expect(tile.dem.backfillBorder).toHaveBeenCalledTimes(0);
    });

    test('backfill when needed', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;
        
        const neighbor = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
        neighbor.state = 'loaded';
        neighbor.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        // Setup neighboringTiles
        tile.neighboringTiles = {
            [neighbor.tileID.key]: {backfilled: false}
        };
        neighbor.neighboringTiles = {
            [tile.tileID.key]: {backfilled: false}
        };

        const inViewTiles = new InViewTiles();
        inViewTiles.setTile(tile.tileID.key, tile);
        inViewTiles.setTile(neighbor.tileID.key, neighbor);

        backfillDEM(tile, inViewTiles);

        expect(tile.dem.backfillBorder).toHaveBeenCalledTimes(1);
        expect(neighbor.dem.backfillBorder).toHaveBeenCalledTimes(1);
    });

    test('avoids redundant backfilling', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;
        
        const neighbor = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
        neighbor.state = 'loaded';
        neighbor.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        // Setup neighboringTiles
        tile.neighboringTiles = {
            [neighbor.tileID.key]: {backfilled: false}
        };
        neighbor.neighboringTiles = {
            [tile.tileID.key]: {backfilled: false}
        };

        const inViewTiles = new InViewTiles();
        inViewTiles.setTile(tile.tileID.key, tile);
        inViewTiles.setTile(neighbor.tileID.key, neighbor);

        backfillDEM(tile, inViewTiles);
        backfillDEM(neighbor, inViewTiles);

        expect(tile.dem.backfillBorder).toHaveBeenCalledTimes(1);
        expect(neighbor.dem.backfillBorder).toHaveBeenCalledTimes(1);
        expect(tile.neighboringTiles[neighbor.tileID.key].backfilled).toBe(true);
    });

    // PATCH (map2-fork): preloaded viewports load while none of their tiles are in
    // view — the walk must reach pinned preload neighbours too, or every internal
    // border stays clamped and hillshade shows a seam on tile edges after promotion.
    test('backfills against pinned preloaded neighbors that are not in view', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        const neighbor = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
        neighbor.state = 'loaded';
        neighbor.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        tile.neighboringTiles = {
            [neighbor.tileID.key]: {backfilled: false}
        };
        neighbor.neighboringTiles = {
            [tile.tileID.key]: {backfilled: false}
        };

        // neither tile is in view; the neighbor is a pinned preload
        const preloaded = {
            [neighbor.tileID.key]: {tile: neighbor}
        };

        backfillDEM(tile, new InViewTiles(), preloaded);

        expect(tile.dem.backfillBorder).toHaveBeenCalledTimes(1);
        expect(neighbor.dem.backfillBorder).toHaveBeenCalledTimes(1);
        expect(tile.neighboringTiles[neighbor.tileID.key].backfilled).toBe(true);
        expect(neighbor.neighboringTiles[tile.tileID.key].backfilled).toBe(true);
    });

    test('preload walk skips already-backfilled directions', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        const neighbor = new Tile(new OverscaledTileID(1, 0, 1, 1, 0), 512);
        neighbor.state = 'loaded';
        neighbor.dem = {
            backfillBorder: vi.fn()
        } as any as DEMData;

        tile.neighboringTiles = {
            [neighbor.tileID.key]: {backfilled: false}
        };
        neighbor.neighboringTiles = {
            [tile.tileID.key]: {backfilled: false}
        };

        const preloaded = {
            [neighbor.tileID.key]: {tile: neighbor}
        };

        backfillDEM(tile, new InViewTiles(), preloaded);
        // second pass (e.g. promote-time catch-all in _addTile) must be a no-op
        backfillDEM(tile, new InViewTiles(), preloaded);

        expect(tile.dem.backfillBorder).toHaveBeenCalledTimes(1);
        expect(neighbor.dem.backfillBorder).toHaveBeenCalledTimes(1);
    });
});
