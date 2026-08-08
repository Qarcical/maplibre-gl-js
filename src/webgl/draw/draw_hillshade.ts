import {Texture} from '../texture';
import {StencilMode} from '../stencil_mode';
import {DepthMode} from '../depth_mode';
import {CullFaceMode} from '../cull_face_mode';
import {type ColorMode} from '../color_mode';
import {
    hillshadeUniformValues,
    hillshadeUniformPrepareValues
} from '../program/hillshade_program';
import {getFadeProperties} from './raster_fade_values';

import type {Painter, RenderOptions} from '../../render/painter';
import type {TileManager} from '../../tile/tile_manager';
import type {HillshadeStyleLayer} from '../../style/style_layer/hillshade_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';

export function drawHillshade(painter: Painter, tileManager: TileManager, layer: HillshadeStyleLayer, tileIDs: OverscaledTileID[], renderOptions: RenderOptions) {
    if (painter.renderPass !== 'offscreen' && painter.renderPass !== 'translucent') return;

    const {isRenderingToTexture} = renderOptions;
    const context = painter.context;
    const projection = painter.style.projection;
    const useSubdivision = projection.useSubdivision;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    const colorMode = painter.colorModeForRenderPass();

    if (painter.renderPass === 'offscreen') {
        // Prepare tiles
        prepareHillshade(painter, tileManager, tileIDs, layer, depthMode, StencilMode.disabled, colorMode);
        context.viewport.set([0, 0, painter.width, painter.height]);
    } else if (painter.renderPass === 'translucent') {
        // Globe (or any projection with subdivision) needs two-pass rendering to avoid artifacts when rendering texture tiles.
        // See comments in draw_raster.ts for more details.
        if (useSubdivision) {
            // Two-pass rendering
            const [stencilBorderless, stencilBorders, coords] = painter.stencilConfigForOverlapTwoPass(tileIDs);
            renderHillshade(painter, tileManager, layer, coords, stencilBorderless, depthMode, colorMode, false, isRenderingToTexture); // draw without borders
            renderHillshade(painter, tileManager, layer, coords, stencilBorders, depthMode, colorMode, true, isRenderingToTexture); // draw with borders
        } else {
            // Simple rendering
            const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
            renderHillshade(painter, tileManager, layer, coords, stencil, depthMode, colorMode, false, isRenderingToTexture);
        }
    }
}

function renderHillshade(
    painter: Painter,
    tileManager: TileManager,
    layer: HillshadeStyleLayer,
    coords: OverscaledTileID[],
    stencilModes: {[_: number]: Readonly<StencilMode>},
    depthMode: Readonly<DepthMode>,
    colorMode: Readonly<ColorMode>,
    useBorder: boolean,
    isRenderingToTexture: boolean
) {
    const projection = painter.style.projection;
    const context = painter.context;
    const transform = painter.transform;
    const gl = context.gl;

    const defines = [`#define NUM_ILLUMINATION_SOURCES ${layer.paint.get('hillshade-highlight-color').values.length}`];
    const program = painter.useProgram('hillshade', null, false, defines);
    const align = !painter.options.moving;
    const sourceMaxZoom = tileManager.getSource().maxzoom;
    // PATCH (map2-fork): raster-dem tile-transition cross-fade (same state and maths as
    // raster's — see raster_fade_values). The parent must have a PREPARED texture to fade
    // from; a parent that was never on screen has no fbo and the tile draws unfaded.
    const fadeDuration = tileManager._effectiveFadeDuration();
    const isTerrain = !!painter.style.map.terrain;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        const fbo = tile.fbo;
        if (!fbo) {
            continue;
        }
        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');

        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

        const fade = getFadeProperties(tile, tileManager, fadeDuration, isTerrain, (p) => !!p.fbo);
        tile.fadeOpacity = fade.fadeValues.tileOpacity;
        context.activeTexture.set(gl.TEXTURE1);
        if (fade.parentTile) {
            fade.parentTile.fadeOpacity = fade.fadeValues.parentTileOpacity;
            gl.bindTexture(gl.TEXTURE_2D, fade.parentTile.fbo.colorAttachment.get());
        } else {
            gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());
        }

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.backCCW,
            hillshadeUniformValues(painter, tile, layer, sourceMaxZoom, {
                parentTile: fade.parentTile,
                parentTopLeft: fade.parentTopLeft,
                parentScaleBy: fade.parentScaleBy,
                fadeMix: fade.fadeValues.fadeMix,
            }), terrainData, projectionData, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}

// hillshade rendering is done in two steps. the prepare step first calculates the slope of the terrain in the x and y
// directions for each pixel, and saves those values to a framebuffer texture in the r and g channels.
function prepareHillshade(
    painter: Painter,
    tileManager: TileManager,
    tileIDs: OverscaledTileID[],
    layer: HillshadeStyleLayer,
    depthMode: Readonly<DepthMode>,
    stencilMode: Readonly<StencilMode>,
    colorMode: Readonly<ColorMode>) {

    const context = painter.context;
    const gl = context.gl;

    const textureFilter = layer.paint.get('resampling') === 'nearest' ?  gl.NEAREST : gl.LINEAR;

    // PATCH (map2-fork): cap fresh prepares per frame in 2D — a promoted close-up DEM
    // ladder (goal-zoom window entry) used to allocate every tile's fbo and run every
    // prepare draw in one frame, ungated and unmeasured (~1MB RGBA fbo per tile).
    // A deferred tile draws nothing for a frame or two (renderHillshade skips fbo-less
    // tiles), which reads as the shading fading in tile-by-tile — invisible next to
    // the frame spike it replaces. 3D keeps the uncapped path: RTT drapes cache what
    // they rendered, and a drape baked while a tile had no fbo would keep the hole.
    const prepareCap = painter.style.map.terrain ? Infinity : 4;
    let prepareDeferred = false;

    for (const coord of tileIDs) {
        const tile = tileManager.getTile(coord);
        const dem = tile.dem;

        if (!dem?.data) {
            continue;
        }

        if (!tile.needsHillshadePrepare) {
            continue;
        }

        if (painter.demPreparesThisFrame >= prepareCap) {
            prepareDeferred = true;
            continue;
        }
        painter.demPreparesThisFrame++;

        const tileSize = dem.dim;

        // PATCH (map2-fork): the DEM uploads as R32F metres (shared tile.demTexture with
        // color-relief; see draw_color_relief.ts). NEAREST as before — the prepare pass taps
        // exact texel centres. Never pooled (the pool is RGBA-only). The upload scheduler's
        // grant usually created the texture already (Tile.upload); re-upload only after a
        // backfillBorder mutation (demTextureDirty).
        context.activeTexture.set(gl.TEXTURE1);

        context.pixelStoreUnpackPremultiplyAlpha.set(false);
        if (!tile.demTexture) {
            tile.demTexture = new Texture(context, dem.getFloatPixels(), (gl as WebGL2RenderingContext).R32F, {premultiply: false});
        } else if (tile.demTextureDirty) {
            tile.demTexture.update(dem.getFloatPixels(), {premultiply: false});
        }
        tile.demTextureDirty = false;
        tile.demTexture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);

        context.activeTexture.set(gl.TEXTURE0);

        let fbo = tile.fbo;

        if (!fbo) {
            const renderTexture = new Texture(context, {width: tileSize, height: tileSize, data: null}, gl.RGBA);
            renderTexture.bind(textureFilter, gl.CLAMP_TO_EDGE);

            fbo = tile.fbo = context.createFramebuffer(tileSize, tileSize, true, false);
            fbo.colorAttachment.set(renderTexture.texture);
            // The wrapper isn't retained anywhere else — hand it to the fbo so
            // unloadTile's fbo.destroy() decrements the glMem gauge (see Framebuffer).
            fbo.colorTexture = renderTexture;
        }

        context.bindFramebuffer.set(fbo.framebuffer);
        context.viewport.set([0, 0, tileSize, tileSize]);

        painter.useProgram('hillshadePrepare').draw(context, gl.TRIANGLES,
            depthMode, stencilMode, colorMode, CullFaceMode.disabled,
            hillshadeUniformPrepareValues(tile.tileID, dem),
            null, null, layer.id, painter.rasterBoundsBuffer,
            painter.quadTriangleIndexBuffer, painter.rasterBoundsSegments);

        tile.needsHillshadePrepare = false;
    }

    if (prepareDeferred) {
        // finish the deferred prepares on subsequent frames even if nothing else is
        // animating (a static camera after a plain pan would otherwise hold the hole)
        painter.style.map.triggerRepaint();
    }
}
