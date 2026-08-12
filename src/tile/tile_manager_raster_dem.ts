import {type Tile} from './tile';
import {type InViewTiles} from './tile_manager_in_view_tiles';

/**
 * For raster terrain source, backfill DEM to eliminate visible tile boundaries
 */
export function backfillDEM(tile: Tile, inViewTiles: InViewTiles, preloadedTiles?: Record<string, {tile: Tile}>) {
    // PATCH (map2-fork): walk ALL in-view tiles, not just renderable ones — a fresh
    // neighbour whose first upload the scheduler still gates (Tile.gatedUpload) isn't
    // renderable yet, and skipping it here would leave the shared border unfilled
    // (backfill runs on load and on preload/LRU promotion in _addTile). fillBorder
    // itself guards on dem presence.
    for (const borderId of inViewTiles.getAllIds()) {
        visitNeighbor(tile, borderId, inViewTiles.getTileById(borderId));
    }
    // PATCH (map2-fork): also walk pinned preloads — a preloaded viewport (goal-zoom
    // window, follow-cam prediction) loads while NONE of its tiles are in view, so the
    // in-view walk alone left every internal border clamped to the tile's own edge row.
    // The clamped border flattens the hillshade derivative along the edge, and the seam
    // survived promotion and the trip through the LRU: a thin light/dark line pinned to
    // tile-row boundaries (first seen just south of the Teide summit on cantracker).
    if (preloadedTiles) {
        for (const borderId in preloadedTiles) {
            visitNeighbor(tile, borderId, preloadedTiles[borderId].tile);
        }
    }
}

function visitNeighbor(tile: Tile, borderId: string, borderTile: Tile) {
    if (!tile.neighboringTiles?.[borderId]) {
        return;
    }
    if (!tile.neighboringTiles[borderId].backfilled) {
        fillBorder(tile, borderTile);
    }
    if (borderTile.neighboringTiles?.[tile.tileID.key]?.backfilled) {
        return;
    }
    fillBorder(borderTile, tile);
}

function fillBorder(tile: Tile, borderTile: Tile) {
    tile.needsHillshadePrepare = true;
    tile.needsTerrainPrepare = true;
    let dx = borderTile.tileID.canonical.x - tile.tileID.canonical.x;
    const dy = borderTile.tileID.canonical.y - tile.tileID.canonical.y;
    const dim = Math.pow(2, tile.tileID.canonical.z);
    const borderId = borderTile.tileID.key;
    if (dx === 0 && dy === 0) return;

    if (Math.abs(dy) > 1) {
        return;
    }
    if (Math.abs(dx) > 1) {
        // Adjust the delta coordinate for world wraparound.
        if (Math.abs(dx + dim) === 1) {
            dx += dim;
        } else if (Math.abs(dx - dim) === 1) {
            dx -= dim;
        }
    }
    if (!borderTile.dem || !tile.dem) return;
    tile.dem.backfillBorder(borderTile.dem, dx, dy);
    // PATCH (map2-fork): the dem just mutated — an already-uploaded R32F texture must
    // re-upload on next use (see Tile.demTextureDirty).
    tile.demTextureDirty = true;
    if (tile.neighboringTiles?.[borderId]) {
        tile.neighboringTiles[borderId].backfilled = true;
    }
}
