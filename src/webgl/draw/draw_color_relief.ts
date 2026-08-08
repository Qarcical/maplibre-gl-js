import {Texture} from '../texture';
import type {StencilMode} from '../stencil_mode';
import {DepthMode} from '../depth_mode';
import {CullFaceMode} from '../cull_face_mode';
import {type ColorMode} from '../color_mode';
import {
    colorReliefUniformValues
} from '../program/color_relief_program';
import {getFadeProperties} from './raster_fade_values';

import type {Painter, RenderOptions} from '../../render/painter';
import type {TileManager} from '../../tile/tile_manager';
import type {ColorReliefStyleLayer} from '../../style/style_layer/color_relief_style_layer';
import type {OverscaledTileID} from '../../tile/tile_id';

export function drawColorRelief(painter: Painter, tileManager: TileManager, layer: ColorReliefStyleLayer, tileIDs: OverscaledTileID[], renderOptions: RenderOptions) {
    if (painter.renderPass !== 'translucent') return;
    if (!tileIDs.length) return;

    const {isRenderingToTexture} = renderOptions;
    const projection = painter.style.projection;
    const useSubdivision = projection.useSubdivision;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    const colorMode = painter.colorModeForRenderPass();

    // Globe (or any projection with subdivision) needs two-pass rendering to avoid artifacts when rendering texture tiles.
    // See comments in draw_raster.ts for more details.
    if (useSubdivision) {
        // Two-pass rendering
        const [stencilBorderless, stencilBorders, coords] = painter.stencilConfigForOverlapTwoPass(tileIDs);
        renderColorRelief(painter, tileManager, layer, coords, stencilBorderless, depthMode, colorMode, false, isRenderingToTexture); // draw without borders
        renderColorRelief(painter, tileManager, layer, coords, stencilBorders, depthMode, colorMode, true, isRenderingToTexture); // draw with borders
    } else {
        // Simple rendering
        const [stencil, coords] = painter.getStencilConfigForOverlapAndUpdateStencilID(tileIDs);
        renderColorRelief(painter, tileManager, layer, coords, stencil, depthMode, colorMode, false, isRenderingToTexture);
    }
}

let textureMaxSize = 0;
function renderColorRelief(
    painter: Painter,
    tileManager: TileManager,
    layer: ColorReliefStyleLayer,
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
    const program = painter.useProgram('colorRelief');
    const align = !painter.options.moving;

    // PATCH (map2-fork): the DEM texture is R32F; LINEAR on float textures needs
    // OES_texture_float_linear — fall back to NEAREST without it.
    const textureFilter = (layer.paint.get('resampling') === 'nearest' || !context.floatTextureLinearSupported) ? gl.NEAREST : gl.LINEAR;
    // PATCH (map2-fork): raster-dem tile-transition cross-fade inputs (see the fade
    // block in the tile loop below).
    const fadeDuration = tileManager._effectiveFadeDuration();
    const isTerrain = !!painter.style.map.terrain;

    let firstTile = true;
    let colorRampSize = 0;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        const dem = tile.dem;
        if(firstTile) {
            // we should avoid calling gl.getParameter at runtime (GPU stall risk)
            textureMaxSize ||= gl.getParameter(gl.MAX_TEXTURE_SIZE);
            const maxLength = textureMaxSize;
            const {elevationTexture, colorTexture} = layer.getColorRampTextures(context, maxLength);
            context.activeTexture.set(gl.TEXTURE1);
            elevationTexture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
            context.activeTexture.set(gl.TEXTURE4);
            colorTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            firstTile = false;
            colorRampSize = elevationTexture.size[0];
        }

        if (!dem?.data) {
            continue;
        }

        // PATCH (map2-fork): upload the DEM as a single-channel R32F texture in METRES so the GPU
        // filters linear heights (see color_relief.fragment.glsl). Never pooled — the painter's
        // tile-texture pool is RGBA and recycling a float texture there would corrupt later users.
        // Upload once, not per frame: the scheduler's grant usually created the texture already
        // (Tile.upload); update only after a backfillBorder mutation (demTextureDirty) — this
        // draw runs every frame for every covering tile, and the unconditional update() here
        // used to re-upload every DEM every frame.
        context.activeTexture.set(gl.TEXTURE0);

        context.pixelStoreUnpackPremultiplyAlpha.set(false);
        if (!tile.demTexture) {
            tile.demTexture = new Texture(context, dem.getFloatPixels(), (gl as WebGL2RenderingContext).R32F, {premultiply: false});
        } else if (tile.demTextureDirty) {
            tile.demTexture.update(dem.getFloatPixels(), {premultiply: false});
        }
        tile.demTextureDirty = false;
        tile.demTexture.bind(textureFilter, gl.CLAMP_TO_EDGE);

        // PATCH (map2-fork): raster-dem tile-transition cross-fade — bind the fading
        // parent's DEM texture (unit 5; 0/1/4 are taken above) and mix elevations
        // in-shader. A parent that was on screen already has its demTexture.
        const fade = getFadeProperties(tile, tileManager, fadeDuration, isTerrain, (p) => !!p.demTexture);
        tile.fadeOpacity = fade.fadeValues.tileOpacity;
        context.activeTexture.set(gl.TEXTURE5);
        if (fade.parentTile) {
            fade.parentTile.fadeOpacity = fade.fadeValues.parentTileOpacity;
            fade.parentTile.demTexture.bind(textureFilter, gl.CLAMP_TO_EDGE);
        } else {
            tile.demTexture.bind(textureFilter, gl.CLAMP_TO_EDGE);
        }

        const mesh = projection.getMeshFromTileID(context, coord.canonical, useBorder, true, 'raster');

        const terrainData = painter.style.map.terrain?.getTerrainData(coord);

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            aligned: align,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        program.draw(context, gl.TRIANGLES, depthMode, stencilModes[coord.overscaledZ], colorMode, CullFaceMode.backCCW,
            colorReliefUniformValues(layer, tile.dem, colorRampSize, {
                parentTile: fade.parentTile,
                parentTopLeft: fade.parentTopLeft,
                parentScaleBy: fade.parentScaleBy,
                fadeMix: fade.fadeValues.fadeMix,
            }), terrainData, projectionData, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}
