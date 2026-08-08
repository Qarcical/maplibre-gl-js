// PATCH (map2-fork): the per-tile fade maths extracted from draw_raster so the DEM-driven
// layers (hillshade, color-relief) can reuse the identical cross-fade/self-fade behaviour —
// same fade state (updateFadingTiles), same parent sampling geometry, same timing curves.
// Behaviour is unchanged for raster; the only generalisation is `parentRenderable`, because
// each consumer needs a different resource on the parent tile before it can sample it
// (raster: tile.texture, hillshade: tile.fbo, color-relief: tile.dem).
import {clamp} from '../../util/util';
import {now} from '../../util/time_control';
import {FadingDirections} from '../../tile/tile';

import type {TileManager} from '../../tile/tile_manager';
import type {Tile} from '../../tile/tile';

export type FadeProperties = {
    parentTile: Tile;
    parentScaleBy: number;
    parentTopLeft: [number, number];
    fadeValues: FadeValues;
};

export type FadeValues = {
    tileOpacity: number;
    parentTileOpacity?: number;
    fadeMix: {opacity: number; mix: number};
};

/**
 * Get fade properties for current tile - either cross-fading or self-fading properties.
 */
export function getFadeProperties(
    tile: Tile,
    tileManager: TileManager,
    fadeDuration: number,
    isTerrain: boolean,
    parentRenderable: (parent: Tile) => boolean
): FadeProperties {
    const defaults: FadeProperties = {
        parentTile: null,
        parentScaleBy: 1,
        parentTopLeft: [0, 0],
        fadeValues: {tileOpacity: 1, parentTileOpacity: 1, fadeMix: {opacity: 1, mix: 0}}
    };

    if (fadeDuration === 0 || isTerrain) return defaults;

    // cross-fade with parent first if available
    if (tile.fadingParentID) {
        const parentTile = tileManager.getLoadedTile(tile.fadingParentID);
        // no parent (or a parent with nothing renderable to fade from) — no cross-fade
        if (!parentTile || !parentRenderable(parentTile)) return defaults;

        const parentScaleBy = Math.pow(2, parentTile.tileID.overscaledZ - tile.tileID.overscaledZ);
        const parentTopLeft: [number, number] = [
            (tile.tileID.canonical.x * parentScaleBy) % 1,
            (tile.tileID.canonical.y * parentScaleBy) % 1
        ];

        const fadeValues = getCrossFadeValues(tile, parentTile, fadeDuration);
        return {parentTile, parentScaleBy, parentTopLeft, fadeValues};
    }

    // self-fade for edge tiles
    if (tile.selfFading) {
        const fadeValues = getSelfFadeValues(tile, fadeDuration);
        return {parentTile: null, parentScaleBy: 1, parentTopLeft: [0, 0], fadeValues};
    }

    return defaults;
}

// PATCH (map2-fork): fade progress clocked from fadeEndTime — the timestamp the fading
// ROLE was assigned (setCrossFadeLogic/setSelfFadeLogic stamp it as now + duration) — not
// from timeAdded as stock did. Stock's timeAdded clock only produces a visible fade when
// the tile was JUST loaded; a resident tile swapped in at a ring boundary has an ancient
// timeAdded, so its fade completed instantly — the hard cut this machinery exists to
// remove, and the common case here because the challenge animations preload everything.
// For freshly loaded tiles the two clocks agree (_tileLoaded re-stamps fadeEndTime).
function fadeProgress(tile: Tile, currentTime: number, fadeDuration: number): number {
    return 1 - clamp((tile.fadeEndTime - currentTime) / fadeDuration, 0, 1);
}

/**
 * Cross-fade values for a base tile with a parent tile (for zooming in/out)
 */
function getCrossFadeValues(tile: Tile, parentTile: Tile, fadeDuration: number): FadeValues {
    const currentTime = now();

    // get fading opacity based on current fade direction
    const doFadeIn = (tile.fadingDirection === FadingDirections.Incoming);
    const opacity1 = fadeProgress(tile, currentTime, fadeDuration);
    const opacity2 = 1 - fadeProgress(parentTile, currentTime, fadeDuration);

    const tileOpacity = doFadeIn ? opacity1 : opacity2;
    const parentTileOpacity = doFadeIn ? opacity2 : opacity1;
    const fadeMix = {
        opacity: 1,
        mix: 1 - tileOpacity
    };

    return {tileOpacity, parentTileOpacity, fadeMix};
}

/**
 * Simple fade-in values for tile without a parent (i.e. edge tiles)
 */
function getSelfFadeValues(tile: Tile, fadeDuration: number): FadeValues {
    const currentTime = now();

    const tileOpacity = fadeProgress(tile, currentTime, fadeDuration);
    const fadeMix = {
        opacity: tileOpacity,
        mix: 0
    };

    return {tileOpacity, fadeMix};
}
