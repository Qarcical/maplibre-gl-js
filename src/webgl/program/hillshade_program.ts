import {mat4} from 'gl-matrix';

import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    UniformColor,
    UniformFloatArray,
    UniformColorArray,
    UniformMatrix4f,
    Uniform4f
} from '../uniform_binding';
import {EXTENT} from '../../data/extent';
import {MercatorCoordinate} from '../../geo/mercator_coordinate';

import type {Context} from '../../webgl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {Tile} from '../../tile/tile';
import type {Painter} from '../../render/painter';
import type {HillshadeStyleLayer} from '../../style/style_layer/hillshade_style_layer';
import type {DEMData} from '../../data/dem_data';
import type {OverscaledTileID} from '../../tile/tile_id';

export type HillshadeUniformsType = {
    'u_image': Uniform1i;
    'u_latrange': Uniform2f;
    'u_exaggeration': Uniform1f;
    'u_zoom_adjust': Uniform1f;
    'u_altitudes': UniformFloatArray;
    'u_azimuths': UniformFloatArray;
    'u_accent': UniformColor;
    'u_method': Uniform1i;
    'u_shadows': UniformColorArray;
    'u_highlights': UniformColorArray;
    // PATCH (map2-fork): raster-dem tile-transition cross-fade (see draw_hillshade)
    'u_image_parent': Uniform1i;
    'u_tl_parent': Uniform2f;
    'u_scale_parent': Uniform1f;
    'u_fade_t': Uniform1f;
    'u_fade_opacity': Uniform1f;
    'u_zoom_adjust_parent': Uniform1f;
    // PATCH (map2-fork): node-grid sampling map (see hillshade.vertex.glsl)
    'u_node_map': Uniform2f;
};

export type HillshadePrepareUniformsType = {
    'u_matrix': UniformMatrix4f;
    'u_image': Uniform1i;
    'u_dimension': Uniform2f;
    'u_zoom': Uniform1f;
};

const hillshadeUniforms = (context: Context, locations: UniformLocations): HillshadeUniformsType => ({
    'u_image': new Uniform1i(context, locations.u_image),
    'u_latrange': new Uniform2f(context, locations.u_latrange),
    'u_exaggeration': new Uniform1f(context, locations.u_exaggeration),
    'u_zoom_adjust': new Uniform1f(context, locations.u_zoom_adjust),
    'u_altitudes': new UniformFloatArray(context, locations.u_altitudes),
    'u_azimuths': new UniformFloatArray(context, locations.u_azimuths),
    'u_accent': new UniformColor(context, locations.u_accent),
    'u_method': new Uniform1i(context, locations.u_method),
    'u_shadows': new UniformColorArray(context, locations.u_shadows),
    'u_highlights': new UniformColorArray(context, locations.u_highlights),
    'u_image_parent': new Uniform1i(context, locations.u_image_parent),
    'u_tl_parent': new Uniform2f(context, locations.u_tl_parent),
    'u_scale_parent': new Uniform1f(context, locations.u_scale_parent),
    'u_fade_t': new Uniform1f(context, locations.u_fade_t),
    'u_fade_opacity': new Uniform1f(context, locations.u_fade_opacity),
    'u_zoom_adjust_parent': new Uniform1f(context, locations.u_zoom_adjust_parent),
    'u_node_map': new Uniform2f(context, locations.u_node_map)
});

const hillshadePrepareUniforms = (context: Context, locations: UniformLocations): HillshadePrepareUniformsType => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_dimension': new Uniform2f(context, locations.u_dimension),
    'u_zoom': new Uniform1f(context, locations.u_zoom)
});

// PATCH (map2-fork): the prepare pass scales the stored derivative by a zoom-dependent
// exaggeration term — exaggeration = (z − 15) · 0.3 for z < 15 — evaluated at the TILE's
// integer overscaledZ. That makes shading intensity step by 2^0.3 (~23%) whenever a DEM
// tile is swapped for a different LOD, which the 3D follow-cam does per-tile
// mid-animation (hard brightness pops; there is no fade anywhere in the hillshade path).
// This factor re-bases the derivative onto the same exaggeration curve evaluated at the
// CONTINUOUS covering zoom of the current transform, so all visible tiles share one
// intensity at any instant and it varies smoothly with camera zoom. The covering zoom is
// clamped to the source's maxzoom so the close-up look (every tile at maxzoom) matches
// stock exactly. Disable via map.setHillshadeZoomAdjust(false) (`?nohsadj` in the
// challenge app).
function stockPrepareExaggeration(z: number): number {
    if (z >= 15) return 0;
    const factor = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3;
    return (z - 15) * factor;
}

function getHillshadeZoomAdjust(painter: Painter, tile: Tile, sourceMaxZoom?: number): number {
    if (painter.style.map._hillshadeZoomAdjust === false) return 1;
    let coverZoom = painter.transform.zoom + Math.log2(painter.transform.tileSize / tile.tileSize);
    if (sourceMaxZoom !== undefined && sourceMaxZoom !== null) coverZoom = Math.min(coverZoom, sourceMaxZoom);
    coverZoom = Math.max(0, coverZoom);
    return Math.pow(2, stockPrepareExaggeration(tile.tileID.overscaledZ) - stockPrepareExaggeration(coverZoom));
}

// PATCH (map2-fork): the per-tile fade inputs draw_hillshade / draw_color_relief hand to
// their uniform values — the sampling geometry plus mix from getFadeProperties.
export type DemFadeValues = {
    parentTile: Tile | null;
    parentTopLeft: [number, number];
    parentScaleBy: number;
    fadeMix: {opacity: number; mix: number};
};

const hillshadeUniformValues = (
    painter: Painter,
    tile: Tile,
    layer: HillshadeStyleLayer,
    sourceMaxZoom?: number,
    fade?: DemFadeValues,
): UniformValues<HillshadeUniformsType> => {
    const accent = layer.paint.get('hillshade-accent-color');
    let method;
    switch (layer.paint.get('hillshade-method')) {
        case 'basic':
            method = 4;
            break;
        case 'combined':
            method = 1;
            break;
        case 'igor':
            method = 2;
            break;
        case 'multidirectional':
            method = 3;
            break;
        case 'standard':
        default:
            method = 0;
            break;
    }

    const illumination = layer.getIlluminationProperties();

    for (let i = 0; i < illumination.directionRadians.length; i++) {
        // modify azimuthal angle by map rotation if light is anchored at the viewport
        if (layer.paint.get('hillshade-illumination-anchor') === 'viewport') {
            illumination.directionRadians[i] += painter.transform.bearingInRadians;
        }
    }
    return {
        'u_image': 0,
        'u_latrange': getTileLatRange(painter, tile.tileID),
        'u_exaggeration': layer.paint.get('hillshade-exaggeration'),
        'u_zoom_adjust': getHillshadeZoomAdjust(painter, tile, sourceMaxZoom),
        'u_altitudes': illumination.altitudeRadians,
        'u_azimuths': illumination.directionRadians,
        'u_accent': accent,
        'u_method': method,
        'u_highlights': illumination.highlightColor,
        'u_shadows': illumination.shadowColor,
        'u_image_parent': 1,
        'u_tl_parent': fade ? fade.parentTopLeft : [0, 0],
        'u_scale_parent': fade ? fade.parentScaleBy : 1,
        'u_fade_t': fade?.parentTile ? fade.fadeMix.mix : 0,
        'u_fade_opacity': fade ? fade.fadeMix.opacity : 1,
        'u_zoom_adjust_parent': fade?.parentTile
            ? getHillshadeZoomAdjust(painter, fade.parentTile, sourceMaxZoom)
            : 1,
        // PATCH (map2-fork): the prepared texture is a (dim+1)² node grid, so tile space
        // [0,1] samples texel centres [0.5, dim+0.5] / (dim+1). Parent and child come from
        // the same source and share dim, so one map serves both taps.
        'u_node_map': getNodeMap(tile)
    };
};

// PATCH (map2-fork): scale/offset that map tile space onto the node grid's texel centres.
function getNodeMap(tile: Tile): [number, number] {
    const dim = tile.dem ? tile.dem.dim : tile.tileSize;
    return [dim / (dim + 1), 0.5 / (dim + 1)];
}

const hillshadeUniformPrepareValues = (tileID: OverscaledTileID, dem: DEMData): UniformValues<HillshadePrepareUniformsType> => {

    const stride = dem.stride;
    const matrix = mat4.create();
    // Flip rendering at y axis.
    mat4.ortho(matrix, 0, EXTENT, -EXTENT, 0, 0, 1);
    mat4.translate(matrix, matrix, [0, -EXTENT, 0]);

    return {
        'u_matrix': matrix,
        'u_image': 1,
        'u_dimension': [stride, stride],
        'u_zoom': tileID.overscaledZ
    };
};

function getTileLatRange(painter: Painter, tileID: OverscaledTileID) {
    // for scaling the magnitude of a points slope by its latitude
    const tilesAtZoom = Math.pow(2, tileID.canonical.z);
    const y = tileID.canonical.y;
    return [
        new MercatorCoordinate(0, y / tilesAtZoom).toLngLat().lat,
        new MercatorCoordinate(0, (y + 1) / tilesAtZoom).toLngLat().lat];
}

export {
    hillshadeUniforms,
    hillshadePrepareUniforms,
    hillshadeUniformValues,
    hillshadeUniformPrepareValues,
    getHillshadeZoomAdjust
};
