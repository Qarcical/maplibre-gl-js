import {now} from '../util/time_control';
import {mat4} from 'gl-matrix';
import {TileManager} from '../tile/tile_manager';
import {EXTENT} from '../data/extent';
import {SegmentVector} from '../data/segment';
import {RasterBoundsArray, PosArray, TriangleIndexArray, LineStripIndexArray} from '../data/array_types.g';
import rasterBoundsAttributes from '../data/raster_bounds_attributes';
import posAttributes from '../data/pos_attributes';
import {ProgramConfiguration} from '../data/program_configuration';
import {CrossTileSymbolIndex} from '../symbol/cross_tile_symbol_index';
import {shaders} from '../shaders/shaders';
import {Program} from '../webgl/program';
import {programUniforms} from '../webgl/program/program_uniforms';
import {Context} from '../webgl/context';
import {DepthMode} from '../webgl/depth_mode';
import {StencilMode} from '../webgl/stencil_mode';
import {ColorMode} from '../webgl/color_mode';
import {CullFaceMode} from '../webgl/cull_face_mode';
import {Texture} from '../webgl/texture';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {selectDebugSource, webglDrawFunctions, type DrawFunctions} from '../webgl/draw';
import {type OverscaledTileID} from '../tile/tile_id';
import {Mesh} from './mesh';
import {MercatorShaderDefine, MercatorShaderVariantKey} from '../geo/projection/mercator_projection';
import {UploadScheduler} from './upload_scheduler';
import {glStats} from '../webgl/gl_stats';

import type {IReadonlyTransform} from '../geo/transform_interface';
import type {Style} from '../style/style';
import type {StyleLayer} from '../style/style_layer';
import type {CrossFaded} from '../style/properties';
import type {LineAtlas} from './line_atlas';
import type {ImageManager} from './image_manager';
import type {GlyphManager} from './glyph_manager';
import type {VertexBuffer} from '../webgl/vertex_buffer';
import type {IndexBuffer} from '../webgl/index_buffer';
import type {Framebuffer} from '../webgl/framebuffer';
import type {DepthRangeType, DepthMaskType, DepthFuncType} from '../webgl/types';
import type {ResolvedImage} from '@maplibre/maplibre-gl-style-spec';
import type {IRenderToTexture} from './render_to_texture_interface';
import type {ProjectionData} from '../geo/projection/projection_data';
import {coveringTiles} from '../geo/projection/covering_tiles';
import {isSymbolStyleLayer} from '../style/style_layer/symbol_style_layer';
import {isCircleStyleLayer} from '../style/style_layer/circle_style_layer';
import {isHeatmapStyleLayer} from '../style/style_layer/heatmap_style_layer';
import {isLineStyleLayer} from '../style/style_layer/line_style_layer';
import {isFillStyleLayer} from '../style/style_layer/fill_style_layer';
import {isFillExtrusionStyleLayer} from '../style/style_layer/fill_extrusion_style_layer';
import {isHillshadeStyleLayer} from '../style/style_layer/hillshade_style_layer';
import {isColorReliefStyleLayer} from '../style/style_layer/color_relief_style_layer';
import {isRasterStyleLayer} from '../style/style_layer/raster_style_layer';
import {isBackgroundStyleLayer} from '../style/style_layer/background_style_layer';
import {isCustomStyleLayer} from '../style/style_layer/custom_style_layer';

export type RenderPass = 'offscreen' | 'opaque' | 'translucent';

type PainterOptions = {
    showOverdrawInspector: boolean;
    showTileBoundaries: boolean;
    showPadding: boolean;
    rotating: boolean;
    zooming: boolean;
    moving: boolean;
    fadeDuration: number;
    anisotropicFilterPitch: number;
};

export type RenderOptions = {
    isRenderingToTexture: boolean;
    isRenderingGlobe: boolean;
};

/**
 * @internal
 * Initialize a new painter object.
 */

export class Painter {
    drawFunctions: DrawFunctions;
    context: Context;
    transform: IReadonlyTransform;
    renderToTexture: IRenderToTexture;
    _tileTextures: {
        [_: number]: Texture[];
    };
    numSublayers: number;
    depthEpsilon: number;
    emptyProgramConfiguration: ProgramConfiguration;
    width: number;
    height: number;
    pixelRatio: number;
    tileExtentBuffer: VertexBuffer;
    tileExtentSegments: SegmentVector;
    tileExtentMesh: Mesh;

    debugBuffer: VertexBuffer;
    debugSegments: SegmentVector;
    rasterBoundsBuffer: VertexBuffer;
    rasterBoundsSegments: SegmentVector;
    rasterBoundsBufferPosOnly: VertexBuffer;
    rasterBoundsSegmentsPosOnly: SegmentVector;
    viewportBuffer: VertexBuffer;
    viewportSegments: SegmentVector;
    quadTriangleIndexBuffer: IndexBuffer;
    tileBorderIndexBuffer: IndexBuffer;
    _tileClippingMaskIDs: {[_: string]: number};
    /**
     * true while the current layer's tiles need no stencil clipping (a single source
     * tile covering the whole render target) — stencilModeForClipping returns disabled
     */
    _clippingDisabled: boolean;
    stencilClearMode: StencilMode;
    style: Style;
    options: PainterOptions;
    lineAtlas: LineAtlas;
    imageManager: ImageManager;
    glyphManager: GlyphManager;
    depthRangeFor3D: DepthRangeType;
    opaquePassCutoff: number;
    renderPass: RenderPass;
    currentLayer: number;
    currentStencilSource: string;
    nextStencilID: number;
    id: string;
    // map2 fork: axis-aligned mercator [0..1] window that fill-extrusion fragments are
    // clipped to (challenge plate mask). null = no clip. Set via map.setExtrusionClipRect.
    extrusionClipRect: {minX: number; minY: number; maxX: number; maxY: number} | null;
    _showOverdrawInspector: boolean;
    cache: {[_: string]: Program<any>};
    crossTileSymbolIndex: CrossTileSymbolIndex;
    symbolFadeChange: number;
    debugOverlayTexture: Texture;
    debugOverlayCanvas: HTMLCanvasElement;
    // this object stores the current camera-matrix and the last render time
    // of the terrain-facilitators. e.g. depth & coords framebuffers
    // every time the camera-matrix changes the terrain-facilitators will be redrawn.
    terrainFacilitator: {depthDirty: boolean; coordsDirty: boolean; matrix: mat4; renderTime: number; coordsVersion: number};
    // map2 fork: per-frame time budget for tile GPU uploads (see upload_scheduler.ts);
    // TileManager.prepare gates freshly-arrived tiles through it
    uploadScheduler: UploadScheduler;
    /**
     * map2 fork: the mode `map2:visible-when`-tagged layers are checked against — layers
     * tagged for the other mode are skipped by the render loops and the RTT stack
     * machinery (no draws, no stack content, no pool demand, and live splitters stop
     * splitting). Set via Map#setRenderMode at the app's 2D↔3D plateau crossing; the
     * flip changes the RTT stack signature, so it full-wipes — acceptable, already the
     * rule at that boundary.
     */
    renderMode: '2d' | '3d';
    /** map2 fork: record 2D compiles as terrain warm-up candidates (Map#setTerrainProgramWarming) */
    _terrainWarmRecording: boolean;
    /** map2 fork: 2D compiles whose /terrain twin hasn't been warmed yet */
    _terrainWarmPending: Array<{name: string; configuration: ProgramConfiguration | null; defines: string[]}>;
    /** map2 fork: variant keys already seeded from the style (seedTerrainWarmFromStyle re-calls dedupe here) */
    _terrainWarmSeeded: Set<string>;
    /**
     * map2 fork: pre-allocated / preserved RTT pool framebuffer+texture pairs. Pool
     * object allocation measured 8–99ms EACH on Adreno (the ~280ms first-terrain
     * stall), so the idle warm-up allocates ahead of the first tilt and terrain
     * uninstall returns objects here instead of destroying them — re-entries and the
     * first entry alike find their working set ready.
     */
    _poolStash: Array<{size: number; fbo: Framebuffer; texture: Texture}>;
    /**
     * map2 fork: resident bytes held by _poolStash, capped by _poolStashMaxBytes. The
     * cap is byte-based, not count-based — the old count cap (96) allowed 1.6GB of
     * 16.8MB full-tier objects in theory, and stash residents are exactly the memory
     * the iPhone jetsam ceiling cares about. Objects the stash won't take are
     * destroyed (RenderPool.destruct / shrink fall through to destroy).
     */
    _poolStashBytes: number;
    _poolStashMaxBytes: number;
    /** map2 fork: how many pool objects of each pixel size the idle warm-up should hold ready */
    _poolWarmTargets: Array<{size: number; count: number}> | null;

    /** map2 fork: is this layer excluded from the current render mode? */
    layerModeHidden(layer: StyleLayer): boolean {
        return !!(layer.visibleWhen && layer.visibleWhen !== this.renderMode);
    }

    constructor(gl: WebGLRenderingContext | WebGL2RenderingContext, transform: IReadonlyTransform) {
        this.drawFunctions = webglDrawFunctions;
        this.context = new Context(gl);
        this.transform = transform;
        this._tileTextures = {};
        this.extrusionClipRect = null;
        this.terrainFacilitator = {depthDirty: true, coordsDirty: false, matrix: mat4.identity(new Float64Array(16) as any), renderTime: 0, coordsVersion: 0};
        this.uploadScheduler = new UploadScheduler();
        this.renderMode = '2d';
        this._terrainWarmRecording = false;
        this._terrainWarmPending = [];
        this._terrainWarmSeeded = new Set();
        this._poolStash = [];
        this._poolStashBytes = 0;
        // desktop-class devices (Chromium deviceMemory reports 8 = "8 or more") can
        // afford holding most of a 3D working set between installs; everything else —
        // including iOS Safari, which reports nothing — gets a tight default. The
        // challenge app's device profile overrides via Map#setPoolStashBudget.
        const deviceMemory = typeof navigator !== 'undefined' ? (navigator as {deviceMemory?: number}).deviceMemory : undefined;
        this._poolStashMaxBytes = (deviceMemory >= 8 ? 512 : 192) * 1024 * 1024;
        this._poolWarmTargets = null;

        this.setup();

        // Within each layer there are multiple distinct z-planes that can be drawn to.
        // This is implemented using the WebGL depth buffer.
        this.numSublayers = TileManager.maxOverzooming + TileManager.maxUnderzooming + 1;
        this.depthEpsilon = 1 / Math.pow(2, 16);

        this.crossTileSymbolIndex = new CrossTileSymbolIndex();
    }

    /*
     * Update the GL viewport, projection matrix, and transforms to compensate
     * for a new width and height value.
     */
    resize(width: number, height: number, pixelRatio: number) {
        this.width = Math.floor(width * pixelRatio);
        this.height = Math.floor(height * pixelRatio);
        this.pixelRatio = pixelRatio;
        this.context.viewport.set([0, 0, this.width, this.height]);

        if (this.style) {
            for (const layerId of this.style._order) {
                this.style._layers[layerId].resize();
            }
        }
    }

    setup() {
        const context = this.context;

        const tileExtentArray = new PosArray();
        tileExtentArray.emplaceBack(0, 0);
        tileExtentArray.emplaceBack(EXTENT, 0);
        tileExtentArray.emplaceBack(0, EXTENT);
        tileExtentArray.emplaceBack(EXTENT, EXTENT);
        this.tileExtentBuffer = context.createVertexBuffer(tileExtentArray, posAttributes.members);
        this.tileExtentSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const debugArray = new PosArray();
        debugArray.emplaceBack(0, 0);
        debugArray.emplaceBack(EXTENT, 0);
        debugArray.emplaceBack(0, EXTENT);
        debugArray.emplaceBack(EXTENT, EXTENT);
        this.debugBuffer = context.createVertexBuffer(debugArray, posAttributes.members);
        this.debugSegments = SegmentVector.simpleSegment(0, 0, 4, 5);

        const rasterBoundsArray = new RasterBoundsArray();
        rasterBoundsArray.emplaceBack(0, 0, 0, 0);
        rasterBoundsArray.emplaceBack(EXTENT, 0, EXTENT, 0);
        rasterBoundsArray.emplaceBack(0, EXTENT, 0, EXTENT);
        rasterBoundsArray.emplaceBack(EXTENT, EXTENT, EXTENT, EXTENT);
        this.rasterBoundsBuffer = context.createVertexBuffer(rasterBoundsArray, rasterBoundsAttributes.members);
        this.rasterBoundsSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const rasterBoundsArrayPosOnly = new PosArray();
        rasterBoundsArrayPosOnly.emplaceBack(0, 0);
        rasterBoundsArrayPosOnly.emplaceBack(EXTENT, 0);
        rasterBoundsArrayPosOnly.emplaceBack(0, EXTENT);
        rasterBoundsArrayPosOnly.emplaceBack(EXTENT, EXTENT);
        this.rasterBoundsBufferPosOnly = context.createVertexBuffer(rasterBoundsArrayPosOnly, posAttributes.members);
        this.rasterBoundsSegmentsPosOnly = SegmentVector.simpleSegment(0, 0, 4, 5);

        const viewportArray = new PosArray();
        viewportArray.emplaceBack(0, 0);
        viewportArray.emplaceBack(1, 0);
        viewportArray.emplaceBack(0, 1);
        viewportArray.emplaceBack(1, 1);
        this.viewportBuffer = context.createVertexBuffer(viewportArray, posAttributes.members);
        this.viewportSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const tileLineStripIndices = new LineStripIndexArray();
        tileLineStripIndices.emplaceBack(0);
        tileLineStripIndices.emplaceBack(1);
        tileLineStripIndices.emplaceBack(3);
        tileLineStripIndices.emplaceBack(2);
        tileLineStripIndices.emplaceBack(0);
        this.tileBorderIndexBuffer = context.createIndexBuffer(tileLineStripIndices);

        const quadTriangleIndices = new TriangleIndexArray();
        quadTriangleIndices.emplaceBack(1, 0, 2);
        quadTriangleIndices.emplaceBack(1, 2, 3);
        this.quadTriangleIndexBuffer = context.createIndexBuffer(quadTriangleIndices);

        const gl = this.context.gl;
        this.stencilClearMode = new StencilMode({func: gl.ALWAYS, mask: 0}, 0x0, 0xFF, gl.ZERO, gl.ZERO, gl.ZERO);

        this.tileExtentMesh = new Mesh(this.tileExtentBuffer, this.quadTriangleIndexBuffer, this.tileExtentSegments);
    }

    /*
     * Reset the drawing canvas by clearing the stencil buffer so that we can draw
     * new tiles at the same location, while retaining previously drawn pixels.
     */
    clearStencil() {
        const context = this.context;
        const gl = context.gl;

        this.nextStencilID = 1;
        this.currentStencilSource = undefined;
        this._clippingDisabled = false;

        // As a temporary workaround for https://github.com/mapbox/mapbox-gl-js/issues/5490,
        // pending an upstream fix, we draw a fullscreen stencil=0 clipping mask here,
        // effectively clearing the stencil buffer: once an upstream patch lands, remove
        // this function in favor of context.clear({ stencil: 0x0 })

        const matrix = mat4.create();
        mat4.ortho(matrix, 0, this.width, this.height, 0, 0, 1);
        mat4.scale(matrix, matrix, [gl.drawingBufferWidth, gl.drawingBufferHeight, 0]);

        const projectionData: ProjectionData = {
            mainMatrix: matrix,
            tileMercatorCoords: [0, 0, 1, 1],
            clippingPlane: [0, 0, 0, 0],
            projectionTransition: 0.0,
            fallbackMatrix: matrix,
        };

        // Note: we force a simple mercator projection for the shader, since we want to draw a fullscreen quad.
        this.useProgram('clippingMask', null, true).draw(context, gl.TRIANGLES,
            DepthMode.disabled, this.stencilClearMode, ColorMode.disabled, CullFaceMode.disabled,
            null, null, projectionData,
            '$clipping', this.viewportBuffer,
            this.quadTriangleIndexBuffer, this.viewportSegments);
    }

    _renderTileClippingMasks(layer: StyleLayer, tileIDs: OverscaledTileID[], renderToTexture: boolean, noClipNeeded: boolean = false) {
        if (this.currentStencilSource === layer.source || !layer.isTileClipped() || !tileIDs?.length) {
            return;
        }

        this.currentStencilSource = layer.source;

        if (noClipNeeded) {
            // a single source tile covering the whole render target can neither overlap
            // another tile nor bleed its buffer inside the target — skip the mask
            // stamping entirely and draw the layer without a stencil test
            this._clippingDisabled = true;
            return;
        }
        this._clippingDisabled = false;

        if (this.nextStencilID + tileIDs.length > 256) {
            // we'll run out of fresh IDs so we need to clear and start from scratch
            this.clearStencil();
        }

        const context = this.context;
        context.setColorMode(ColorMode.disabled);
        context.setDepthMode(DepthMode.disabled);

        const stencilRefs = {};

        // Set stencil ref values for all tiles
        for (const tileID of tileIDs) {
            stencilRefs[tileID.key] = this.nextStencilID++;
        }

        // A two-pass approach is needed. See comment in draw_raster.ts for more details.
        // However, we use a simpler approach because we don't care about overdraw here.

        // First pass - draw tiles with borders and with GL_ALWAYS
        this._renderTileMasks(stencilRefs, tileIDs, renderToTexture, true);
        // Second pass - draw borderless tiles with GL_ALWAYS
        this._renderTileMasks(stencilRefs, tileIDs, renderToTexture, false);

        this._tileClippingMaskIDs = stencilRefs;
    }

    _renderTileMasks(tileStencilRefs: {[_: string]: number}, tileIDs: OverscaledTileID[], renderToTexture: boolean, useBorders: boolean) {
        const context = this.context;
        const gl = context.gl;
        const projection = this.style.projection;
        const transform = this.transform;

        const program = this.useProgram('clippingMask');

        // tiles are usually supplied in ascending order of z, then y, then x
        for (const tileID of tileIDs) {
            const stencilRef = tileStencilRefs[tileID.key];
            const terrainData = this.style.map.terrain?.getTerrainData(tileID);

            const mesh = projection.getMeshFromTileID(this.context, tileID.canonical, useBorders, true, 'stencil');

            const projectionData = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: !renderToTexture, applyTerrainMatrix: true});

            program.draw(context, gl.TRIANGLES, DepthMode.disabled,
                // Tests will always pass, and ref value will be written to stencil buffer.
                new StencilMode({func: gl.ALWAYS, mask: 0}, stencilRef, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE),
                ColorMode.disabled, renderToTexture ? CullFaceMode.disabled : CullFaceMode.backCCW, null,
                terrainData, projectionData, '$clipping', mesh.vertexBuffer,
                mesh.indexBuffer, mesh.segments);
        }
    }

    /**
     * Fills the depth buffer with the geometry of all supplied tiles.
     * Does not change the color buffer or the stencil buffer.
     */
    _renderTilesDepthBuffer() {
        const context = this.context;
        const gl = context.gl;
        const projection = this.style.projection;
        const transform = this.transform;

        const program = this.useProgram('depth');
        const depthMode = this.getDepthModeFor3D();
        const tileIDs = coveringTiles(transform, {tileSize: transform.tileSize});

        // tiles are usually supplied in ascending order of z, then y, then x
        for (const tileID of tileIDs) {
            const terrainData = this.style.map.terrain?.getTerrainData(tileID);
            const mesh = projection.getMeshFromTileID(this.context, tileID.canonical, true, true, 'raster');

            const projectionData = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true, applyTerrainMatrix: true});

            program.draw(context, gl.TRIANGLES, depthMode, StencilMode.disabled,
                ColorMode.disabled, CullFaceMode.backCCW, null,
                terrainData, projectionData, '$clipping', mesh.vertexBuffer,
                mesh.indexBuffer, mesh.segments);
        }
    }

    stencilModeFor3D(): StencilMode {
        this.currentStencilSource = undefined;

        if (this.nextStencilID + 1 > 256) {
            this.clearStencil();
        }

        const id = this.nextStencilID++;
        const gl = this.context.gl;
        return new StencilMode({func: gl.NOTEQUAL, mask: 0xFF}, id, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
    }

    stencilModeForClipping(tileID: OverscaledTileID): StencilMode {
        if (this._clippingDisabled) {
            return StencilMode.disabled;
        }
        const gl = this.context.gl;
        return new StencilMode({func: gl.EQUAL, mask: 0xFF}, this._tileClippingMaskIDs[tileID.key], 0x00, gl.KEEP, gl.KEEP, gl.REPLACE);
    }

    /*
     * Sort coordinates by Z as drawing tiles is done in Z-descending order.
     * All children with the same Z write the same stencil value.  Children
     * stencil values are greater than parent's.  This is used only for raster
     * and raster-dem tiles, which are already clipped to tile boundaries, to
     * mask area of tile overlapped by children tiles.
     * Stencil ref values continue range used in _tileClippingMaskIDs.
     *
     * Attention: This function changes this.nextStencilID even if the result of it
     * is not used, which might cause problems when rendering due to invalid stencil
     * values.
     * Returns [StencilMode for tile overscaleZ map, sortedCoords].
     */
    getStencilConfigForOverlapAndUpdateStencilID(tileIDs: OverscaledTileID[]): [{
        [_: number]: Readonly<StencilMode>;
    }, OverscaledTileID[]] {
        const gl = this.context.gl;
        const coords = tileIDs.sort((a, b) => b.overscaledZ - a.overscaledZ);
        const minTileZ = coords[coords.length - 1].overscaledZ;
        const stencilValues = coords[0].overscaledZ - minTileZ + 1;
        if (stencilValues > 1) {
            this.currentStencilSource = undefined;
            if (this.nextStencilID + stencilValues > 256) {
                this.clearStencil();
            }
            const zToStencilMode = {};
            for (let i = 0; i < stencilValues; i++) {
                zToStencilMode[i + minTileZ] = new StencilMode({func: gl.GEQUAL, mask: 0xFF}, i + this.nextStencilID, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
            }
            this.nextStencilID += stencilValues;
            return [zToStencilMode, coords];
        }
        return [{[minTileZ]: StencilMode.disabled}, coords];
    }

    stencilConfigForOverlapTwoPass(tileIDs: OverscaledTileID[]): [
        { [_: number]: Readonly<StencilMode> }, // borderless tiles - high priority & high stencil values
        { [_: number]: Readonly<StencilMode> }, // tiles with border - low priority
        OverscaledTileID[]
    ] {
        const gl = this.context.gl;
        const coords = tileIDs.sort((a, b) => b.overscaledZ - a.overscaledZ);
        const minTileZ = coords[coords.length - 1].overscaledZ;
        const stencilValues = coords[0].overscaledZ - minTileZ + 1;

        this.clearStencil();

        if (stencilValues > 1) {
            const zToStencilModeHigh = {};
            const zToStencilModeLow = {};
            for (let i = 0; i < stencilValues; i++) {
                zToStencilModeHigh[i + minTileZ] = new StencilMode({func: gl.GREATER, mask: 0xFF}, stencilValues + 1 + i, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
                zToStencilModeLow[i + minTileZ] = new StencilMode({func: gl.GREATER, mask: 0xFF}, 1 + i, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
            }
            this.nextStencilID = stencilValues * 2 + 1;
            return [
                zToStencilModeHigh,
                zToStencilModeLow,
                coords
            ];
        } else {
            this.nextStencilID = 3;
            return [
                {[minTileZ]: new StencilMode({func: gl.GREATER, mask: 0xFF}, 2, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE)},
                {[minTileZ]: new StencilMode({func: gl.GREATER, mask: 0xFF}, 1, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE)},
                coords
            ];
        }
    }

    colorModeForRenderPass(): Readonly<ColorMode> {
        const gl = this.context.gl;
        if (this._showOverdrawInspector) {
            const numOverdrawSteps = 8;
            const a = 1 / numOverdrawSteps;

            return new ColorMode([gl.CONSTANT_COLOR, gl.ONE], new Color(a, a, a, 0), [true, true, true, true]);
        } else if (this.renderPass === 'opaque') {
            return ColorMode.unblended;
        } else {
            return ColorMode.alphaBlended;
        }
    }

    getDepthModeForSublayer(n: number, mask: DepthMaskType, func?: DepthFuncType | null): Readonly<DepthMode> {
        if (!this.opaquePassEnabledForLayer()) return DepthMode.disabled;
        const depth = 1 - ((1 + this.currentLayer) * this.numSublayers + n) * this.depthEpsilon;
        return new DepthMode(func || this.context.gl.LEQUAL, mask, [depth, depth]);
    }

    getDepthModeFor3D(): Readonly<DepthMode> {
        return new DepthMode(this.context.gl.LEQUAL, DepthMode.ReadWrite, this.depthRangeFor3D);
    }

    /*
     * The opaque pass and 3D layers both use the depth buffer.
     * Layers drawn above 3D layers need to be drawn using the
     * painter's algorithm so that they appear above 3D features.
     * This returns true for layers that can be drawn using the
     * opaque pass.
     */
    opaquePassEnabledForLayer() {
        return this.currentLayer < this.opaquePassCutoff;
    }

    render(style: Style, options: PainterOptions) {
        this.style = style;
        this.options = options;

        this.lineAtlas = style.lineAtlas;
        this.imageManager = style.imageManager;
        this.glyphManager = style.glyphManager;

        this.symbolFadeChange = style.placement.symbolFadeChange(now());

        this.imageManager.beginFrame();

        const layerIds = this.style._order;
        const tileManagers = this.style.tileManagers;

        const coordsAscending: {[_: string]: OverscaledTileID[]} = {};
        const coordsDescending: {[_: string]: OverscaledTileID[]} = {};
        const coordsDescendingSymbol: {[_: string]: OverscaledTileID[]} = {};
        const renderOptions: RenderOptions = {isRenderingToTexture: false, isRenderingGlobe: style.projection?.transitionState > 0};

        // map2 fork: refresh which sources bypass the upload budget (per-frame anim
        // overlays) before the prepare loop asks for grants
        this.uploadScheduler.updateVolatileSources(style);

        for (const id in tileManagers) {
            const tileManager = tileManagers[id];
            if (tileManager.used) {
                tileManager.prepare(this.context);
            }

            coordsAscending[id] = tileManager.getVisibleCoordinates(false);
            coordsDescending[id] = coordsAscending[id].slice().reverse();
            coordsDescendingSymbol[id] = tileManager.getVisibleCoordinates(true).reverse();
        }

        if (glStats.enabled) {
            glStats.frame.tileUploadsGranted = this.uploadScheduler.granted;
            glStats.frame.tileUploadsExempt = this.uploadScheduler.exemptGranted;
            glStats.frame.tileUploadsDeferred = this.uploadScheduler.deferred;
            glStats.frame.tileUploadMs = this.uploadScheduler.uploadMs;
            glStats.frame.tileUploadBudgetMs = this.uploadScheduler.budgetMs;
        }

        this.opaquePassCutoff = Infinity;
        for (let i = 0; i < layerIds.length; i++) {
            const layerId = layerIds[i];
            if (this.style._layers[layerId].is3D()) {
                this.opaquePassCutoff = i;
                break;
            }
        }

        this.maybeDrawDepth(false);

        if (this.renderToTexture) {
            this.renderToTexture.prepareForRender(this.style, this.transform.zoom);
            // this is disabled, because render-to-texture is rendering all layers from bottom to top.
            this.opaquePassCutoff = 0;
        }

        // Offscreen pass ===============================================
        // We first do all rendering that requires rendering to a separate
        // framebuffer, and then save those for rendering back to the map
        // later: in doing this we avoid doing expensive framebuffer restores.
        this.renderPass = 'offscreen';

        for (const layerId of layerIds) {
            const layer = this.style._layers[layerId];
            if (!layer.hasOffscreenPass() || layer.isHidden(this.transform.zoom) || this.layerModeHidden(layer)) continue;

            const coords = coordsDescending[layer.source];
            if (layer.type !== 'custom' && !coords.length) continue;

            this.renderLayer(this, tileManagers[layer.source], layer, coords, renderOptions);
        }

        // Execute offscreen GPU tasks of the projection manager
        this.style.projection?.updateGPUdependent({
            context: this.context,
            useProgram: (name: string) => this.useProgram(name)
        });

        // Rebind the main framebuffer now that all offscreen layers have been rendered:
        this.context.viewport.set([0, 0, this.width, this.height]);
        this.context.bindFramebuffer.set(null);

        // Clear buffers in preparation for drawing to the main framebuffer
        this.context.clear({color: options.showOverdrawInspector ? Color.black : Color.transparent, depth: 1});
        this.clearStencil();

        // draw sky first to not overwrite symbols
        if (this.style.sky) this.drawFunctions.sky(this, this.style.sky);

        this._showOverdrawInspector = options.showOverdrawInspector;
        this.depthRangeFor3D = [0, 1 - ((style._order.length + 2) * this.numSublayers * this.depthEpsilon)];

        // Opaque pass ===============================================
        // Draw opaque layers top-to-bottom first.
        if (!this.renderToTexture) {
            this.renderPass = 'opaque';

            for (this.currentLayer = layerIds.length - 1; this.currentLayer >= 0; this.currentLayer--) {
                const layer = this.style._layers[layerIds[this.currentLayer]];
                const tileManager = tileManagers[layer.source];
                const coords = coordsAscending[layer.source];

                this._renderTileClippingMasks(layer, coords, false);
                this.renderLayer(this, tileManager, layer, coords, renderOptions);
            }
        }

        // Translucent pass ===============================================
        // Draw all other layers bottom-to-top.
        this.renderPass = 'translucent';

        let globeDepthRendered = false;

        for (this.currentLayer = 0; this.currentLayer < layerIds.length; this.currentLayer++) {
            const layer = this.style._layers[layerIds[this.currentLayer]];
            const tileManager = tileManagers[layer.source];

            if (this.renderToTexture?.renderLayer(layer, renderOptions)) continue;

            if (!this.opaquePassEnabledForLayer() && !globeDepthRendered) {
                globeDepthRendered = true;
                // Render the globe sphere into the depth buffer - but only if globe is enabled and terrain is disabled.
                // There should be no need for explicitly writing tile depths when terrain is enabled.
                if (renderOptions.isRenderingGlobe && !this.style.map.terrain) {
                    this._renderTilesDepthBuffer();
                }
            }

            // For symbol layers in the translucent pass, we add extra tiles to the renderable set
            // for cross-tile symbol fading. Symbol layers don't use tile clipping, so no need to render
            // separate clipping masks
            const coords = (layer.type === 'symbol' ? coordsDescendingSymbol : coordsDescending)[layer.source];

            this._renderTileClippingMasks(layer, coordsAscending[layer.source], !!this.renderToTexture);
            this.renderLayer(this, tileManager, layer, coords, renderOptions);
        }

        // Render atmosphere, only for Globe projection
        if (renderOptions.isRenderingGlobe) {
            this.drawFunctions.atmosphere(this, this.style.sky, this.style.light);
        }

        if (this.options.showTileBoundaries) {
            const selectedSource = selectDebugSource(this.style, this.transform.zoom);
            if (selectedSource) {
                this.drawFunctions.debug(this, selectedSource, selectedSource.getVisibleCoordinates());
            }
        }

        if (this.options.showPadding) {
            this.drawFunctions.debugPadding(this);
        }

        // Set defaults for most GL values so that anyone using the state after the render
        // encounters more expected values.
        this.context.setDefault();
    }

    /**
     * Update the depth framebuffer if the camera has moved or tiles have reloaded.
     * Marks coords as depthDirty so they are re-rendered on next demand.
     */
    maybeDrawDepth(requireExact: boolean) {
        if (!this.style?.map?.terrain) {
            return;
        }
        const prevMatrix = this.terrainFacilitator.matrix;
        const currMatrix = this.transform.modelViewProjectionMatrix;

        // Update depth-framebuffer on camera movement, or tile reloading
        let doUpdate = this.terrainFacilitator.depthDirty;
        doUpdate ||= requireExact ? !mat4.exactEquals(prevMatrix, currMatrix) : !mat4.equals(prevMatrix, currMatrix);
        doUpdate ||= this.style.map.terrain.tileManager.anyTilesAfterTime(this.terrainFacilitator.renderTime);

        if (!doUpdate) {
            return;
        }

        mat4.copy(prevMatrix, currMatrix);
        this.terrainFacilitator.renderTime = Date.now();
        this.terrainFacilitator.depthDirty = false;
        this.terrainFacilitator.coordsDirty = true;
        this.drawFunctions.terrainDepth(this, this.style.map.terrain);
    }

    /**
     * Render the coords framebuffer if it is coordsDirty
     */
    maybeDrawCoords() {
        if (!this.style?.map?.terrain || !this.terrainFacilitator.coordsDirty) {
            return;
        }
        this.terrainFacilitator.coordsDirty = false;
        // map2-fork: version-stamp each coords render so pointCoordinate can memoize
        // its readPixels results for as long as the framebuffer content is unchanged.
        this.terrainFacilitator.coordsVersion++;
        this.drawFunctions.terrainCoords(this, this.style.map.terrain);
    }

    renderLayer(painter: Painter, tileManager: TileManager, layer: StyleLayer, coords: OverscaledTileID[], renderOptions: RenderOptions) {
        if (layer.isHidden(this.transform.zoom) || this.layerModeHidden(layer)) return;
        if (layer.type !== 'background' && layer.type !== 'custom' && !(coords || []).length) return;
        this.id = layer.id;

        const draw = this.drawFunctions;
        if (isSymbolStyleLayer(layer)) {
            draw.symbol(painter, tileManager, layer, coords, this.style.placement.variableOffsets, renderOptions);
        } else if (isCircleStyleLayer(layer)) {
            draw.circle(painter, tileManager, layer, coords, renderOptions);
        } else if (isHeatmapStyleLayer(layer)) {
            draw.heatmap(painter, tileManager, layer, coords, renderOptions);
        } else if (isLineStyleLayer(layer)) {
            draw.line(painter, tileManager, layer, coords, renderOptions);
        } else if (isFillStyleLayer(layer)) {
            draw.fill(painter, tileManager, layer, coords, renderOptions);
        } else if (isFillExtrusionStyleLayer(layer)) {
            draw.fillExtrusion(painter, tileManager, layer, coords, renderOptions);
        } else if (isHillshadeStyleLayer(layer)) {
            draw.hillshade(painter, tileManager, layer, coords, renderOptions);
        } else if (isColorReliefStyleLayer(layer)) {
            draw.colorRelief(painter, tileManager, layer, coords, renderOptions);
        } else if (isRasterStyleLayer(layer)) {
            draw.raster(painter, tileManager, layer, coords, renderOptions);
        } else if (isBackgroundStyleLayer(layer)) {
            draw.background(painter, tileManager, layer, coords, renderOptions);
        } else if (isCustomStyleLayer(layer)) {
            draw.custom(painter, tileManager, layer, renderOptions);
        }
    }

    static readonly MAX_TEXTURE_POOL_SIZE_PER_BUCKET = 50;

    saveTileTexture(texture: Texture) {
        const textures = this._tileTextures[texture.size[0]];
        if (!textures) {
            this._tileTextures[texture.size[0]] = [texture];
        } else if (textures.length < Painter.MAX_TEXTURE_POOL_SIZE_PER_BUCKET) {
            textures.push(texture);
        } else {
            texture.destroy();
        }
    }

    getTileTexture(size: number) {
        const textures = this._tileTextures[size];
        return textures && textures.length > 0 ? textures.pop() : null;
    }

    /**
     * Checks whether a pattern image is needed, and if it is, whether it is not loaded.
     *
     * @returns true if a needed image is missing and rendering needs to be skipped.
     */
    isPatternMissing(image?: CrossFaded<ResolvedImage> | null): boolean {
        if (!image) return false;
        if (!image.from || !image.to) return true;
        const imagePosA = this.imageManager.getPattern(image.from.toString());
        const imagePosB = this.imageManager.getPattern(image.to.toString());
        return !imagePosA || !imagePosB;
    }

    /**
     * Finds the required shader and its variant (base/terrain/globe, etc.) and binds it, compiling a new shader if required.
     * @param name - Name of the desired shader.
     * @param programConfiguration - Configuration of shader's inputs.
     * @param forceSimpleProjection - Whether to force the use of a shader variant with simple mercator projection vertex shader.
     * @param defines - Additional macros to be injected at the beginning of the shader. Expected format is `['#define XYZ']`, etc.
     * False by default. Use true when drawing with a simple projection matrix is desired, eg. when drawing a fullscreen quad.
     * @returns
     */
    useProgram(name: string, programConfiguration?: ProgramConfiguration | null, forceSimpleProjection: boolean = false, defines: string[] = []): Program<any> {
        const useTerrain = !!this.style.map.terrain;
        const {program, compiled} = this._getOrCompileProgram(name, programConfiguration, useTerrain, forceSimpleProjection, defines);
        // map2 fork: remember what a first-use 2D compile looked like so its /terrain
        // twin can be pre-compiled during idle 2D (warmTerrainProgram) — first-terrain
        // frames otherwise compile the whole variant batch synchronously (~300ms of the
        // measured tablet load stall). Recording is opt-in (Map#setTerrainProgramWarming)
        // because candidates retain their ProgramConfiguration until drained.
        if (compiled && this._terrainWarmRecording && !useTerrain && !forceSimpleProjection &&
            !this._showOverdrawInspector && this._terrainWarmPending.length < 64) {
            this._terrainWarmPending.push({name, configuration: programConfiguration ?? null, defines});
        }
        return program;
    }

    /**
     * map2 fork: compile-if-missing, shared by the render path (useProgram) and the
     * idle-time terrain warm-up. Compiles are timed — the constructor's
     * COMPILE/LINK_STATUS queries force synchronous driver compilation.
     */
    _getOrCompileProgram(name: string, programConfiguration: ProgramConfiguration | null | undefined, useTerrain: boolean, forceSimpleProjection: boolean, defines: string[]): {program: Program<any>; compiled: boolean} {
        this.cache ||= {};

        const projection = this.style.projection;

        const projectionPrelude = forceSimpleProjection ? shaders.projectionMercator : projection.shaderPreludeCode;
        const projectionDefine = forceSimpleProjection ? MercatorShaderDefine : projection.shaderDefine;
        const projectionKey = `/${forceSimpleProjection ? MercatorShaderVariantKey : projection.shaderVariantName}`;

        const configurationKey = (programConfiguration ? programConfiguration.cacheKey : '');
        const overdrawKey = (this._showOverdrawInspector ? '/overdraw' : '');
        const terrainKey = (useTerrain ? '/terrain' : '');
        const definesKey = (defines ? `/${defines.join('/')}` : '');

        const key = name + configurationKey + projectionKey + overdrawKey + terrainKey + definesKey;

        let compiled = false;
        if (!this.cache[key]) {
            const compileStart = performance.now();
            this.cache[key] = new Program(
                this.context,
                shaders[name],
                programConfiguration,
                programUniforms[name],
                this._showOverdrawInspector,
                useTerrain,
                projectionPrelude,
                projectionDefine,
                defines
            );
            compiled = true;
            const compileMs = performance.now() - compileStart;
            if (glStats.enabled) {
                glStats.frame.programCompiles++;
                glStats.frame.programCompileMs += compileMs;
                if (compileMs > 8) {
                    console.log(`[map2-fork] slow shader compile: ${key} ${compileMs.toFixed(1)}ms`);
                }
            }
        }
        return {program: this.cache[key], compiled};
    }

    /**
     * map2 fork: compile ONE not-yet-compiled terrain shader variant — the pure terrain
     * programs first, then the /terrain twin of each recorded 2D compile. Called from
     * Map#precompileTerrainPrograms on an idle-paced timer so the ~10–35ms per compile
     * (measured on Adreno) lands in quiet 2D time instead of the first terrain frame.
     * @returns true if a program was compiled; false when everything is already warm
     */
    warmTerrainProgram(): boolean {
        if (!this.style || this.context.gl.isContextLost()) return false;
        for (const name of ['terrain', 'terrainDepth', 'terrainCoords']) {
            if (this._getOrCompileProgram(name, null, true, false, []).compiled) return true;
        }
        while (this._terrainWarmPending.length > 0) {
            const candidate = this._terrainWarmPending.shift();
            if (this._getOrCompileProgram(candidate.name, candidate.configuration, true, false, candidate.defines).compiled) return true;
        }
        return false;
    }

    /**
     * map2 fork: seed the terrain warm queue from the STYLE itself. Recording 2D
     * compiles (useProgram) structurally can't see variants that only ever draw in
     * 3D — photo symbols and anim overlays first draw mid-flight, and their in-frame
     * compiles are the item-(a) residue (44–91ms singles on Adreno at Play entry).
     * This derives each layer's program name(s) and a ProgramConfiguration straight
     * from its evaluated paint declarations, exactly as the worker's bucket build
     * would, so the queue covers every variant the style can request whether or not
     * 2D ever drew it. Requires paint to be evaluated (call after the map's 'load');
     * re-calls are cheap — seeded keys dedupe persistently, and a candidate whose
     * twin is already compiled costs one cache probe at drain time.
     * @returns the number of newly queued candidates
     */
    seedTerrainWarmFromStyle(): number {
        if (!this.style) return 0;
        const zoom = this.transform ? this.transform.zoom : 0;
        let seeded = 0;
        const push = (name: string, configuration: ProgramConfiguration | null, defines: string[] = []) => {
            const key = name + (configuration ? configuration.cacheKey : '') + (defines.length ? `/${defines.join('/')}` : '');
            if (this._terrainWarmSeeded.has(key)) return;
            this._terrainWarmSeeded.add(key);
            this._terrainWarmPending.push({name, configuration, defines});
            seeded++;
        };
        for (const layerId of this.style._order) {
            const layer = this.style._layers[layerId] as any;
            // deliberately NO visibility skip: visibility is a runtime toggle, and the
            // anim overlay layers — the variants this seeding exists for — ship
            // 'none' and only flip visible at anim enter (field-caught 2026-07-15:
            // the skip excluded exactly them). A genuinely-dead hidden layer costs
            // one idle-time compile.
            if (!layer) continue;
            try {
                switch (layer.type) {
                    case 'circle':
                        push('circle', new ProgramConfiguration(layer, zoom, () => true));
                        break;
                    case 'heatmap':
                        push('heatmap', new ProgramConfiguration(layer, zoom, () => true));
                        break;
                    case 'line': {
                        const dasharray = layer.paint.get('line-dasharray').constantOr(1);
                        const image = layer.paint.get('line-pattern').constantOr(1);
                        const gradient = layer.paint.get('line-gradient');
                        const configuration = new ProgramConfiguration(layer, zoom, () => true);
                        push(image ? 'linePattern' :
                            dasharray && gradient ? 'lineGradientSDF' :
                                dasharray ? 'lineSDF' :
                                    gradient ? 'lineGradient' : 'line', configuration);
                        // trim-mode grow sets a line-gradient at RUNTIME (after any warm
                        // drain), which changes the program name but not the configuration.
                        // lineMetrics on the layer's GeoJSON source is trim's own
                        // precondition, so it is exactly the "could this happen" test.
                        if (!image && !gradient && this._sourceHasLineMetrics(layer.source)) {
                            push(dasharray ? 'lineGradientSDF' : 'lineGradient', configuration);
                        }
                        break;
                    }
                    case 'fill': {
                        const image = layer.paint.get('fill-pattern').constantOr(1);
                        const configuration = new ProgramConfiguration(layer, zoom, () => true);
                        push(image ? 'fillPattern' : 'fill', configuration);
                        if (layer.paint.get('fill-antialias')) {
                            push(image && !layer.getPaintProperty('fill-outline-color') ? 'fillOutlinePattern' : 'fillOutline', configuration);
                        }
                        break;
                    }
                    case 'fill-extrusion': {
                        const image = layer.paint.get('fill-extrusion-pattern').constantOr(1);
                        push(image ? 'fillExtrusionPattern' : 'fillExtrusion', new ProgramConfiguration(layer, zoom, () => true));
                        break;
                    }
                    case 'symbol': {
                        if (layer._unevaluatedLayout.hasValue('text-field')) {
                            push('symbolSDF', new ProgramConfiguration(layer, zoom, (property: string) => property.startsWith('text')));
                        }
                        if (layer._unevaluatedLayout.hasValue('icon-image')) {
                            // SDF-ness of the icons is a bucket fact (which images the
                            // features resolve to) — unknowable style-side, so seed both
                            const configuration = new ProgramConfiguration(layer, zoom, (property: string) => property.startsWith('icon'));
                            push('symbolIcon', configuration);
                            push('symbolSDF', configuration);
                        }
                        break;
                    }
                    case 'background':
                        push(layer.paint.get('background-pattern') ? 'backgroundPattern' : 'background', null);
                        break;
                    case 'raster':
                        push('raster', null);
                        break;
                    case 'color-relief':
                        push('colorRelief', null);
                        break;
                    case 'hillshade':
                        push('hillshade', null, [`#define NUM_ILLUMINATION_SOURCES ${layer.paint.get('hillshade-highlight-color').values.length}`]);
                        push('hillshadePrepare', null);
                        break;
                }
            } catch {
                // a layer we can't derive (e.g. paint not yet evaluated) is skipped —
                // the 2D recording path still covers anything 2D eventually draws
            }
        }
        if (this.style.sky) {
            push('sky', null);
        }
        // drawn on every terrain frame regardless of style content
        push('clippingMask', null);
        push('depth', null);
        return seeded;
    }

    /** map2 fork: is this layer's source a GeoJSON source built with lineMetrics? (trim-mode precondition) */
    _sourceHasLineMetrics(sourceId: string | undefined): boolean {
        if (!sourceId || !this.style) return false;
        const source = this.style.getSource(sourceId) as {workerOptions?: {geojsonVtOptions?: {lineMetrics?: boolean}}};
        return !!source?.workerOptions?.geojsonVtOptions?.lineMetrics;
    }

    /** map2 fork: hand a stashed framebuffer+texture pair to a RenderPool (see _poolStash) */
    takePoolStash(size: number): {fbo: Framebuffer; texture: Texture} | null {
        for (let i = 0; i < this._poolStash.length; i++) {
            if (this._poolStash[i].size === size) {
                const [entry] = this._poolStash.splice(i, 1);
                this._poolStashBytes -= size * size * 4;
                return entry;
            }
        }
        return null;
    }

    /** map2 fork: keep a destructed/shrunk pool object's GPU resources for the next use (byte-capped) */
    stashPoolObject(size: number, fbo: Framebuffer, texture: Texture): boolean {
        const bytes = size * size * 4;
        if (this._poolStashBytes + bytes > this._poolStashMaxBytes) return false;
        this._poolStash.push({size, fbo, texture});
        this._poolStashBytes += bytes;
        return true;
    }

    /** map2 fork: destroy stash entries until the stash fits its byte budget (newest first) */
    trimPoolStash() {
        while (this._poolStashBytes > this._poolStashMaxBytes && this._poolStash.length > 0) {
            const entry = this._poolStash.pop();
            this._poolStashBytes -= entry.size * entry.size * 4;
            entry.texture.destroy();
            entry.fbo.destroy();
        }
    }

    /**
     * map2 fork: allocate ONE RTT pool object toward the warm targets, on the same
     * idle drain as the shader warm-up. No-ops while terrain is installed (the live
     * pools own the objects; uninstall returns them to the stash).
     * @returns true if an object was allocated; false when targets are satisfied
     */
    warmPoolObject(): boolean {
        if (!this._poolWarmTargets || this.renderToTexture || this.context.gl.isContextLost()) return false;
        for (const target of this._poolWarmTargets) {
            const have = this._poolStash.reduce((n, entry) => n + (entry.size === target.size ? 1 : 0), 0);
            if (have >= target.count) continue;
            // the stash byte budget bounds warming too — on a constrained profile a
            // partial warm set is the intended trade (the rest allocates on demand)
            if (this._poolStashBytes + target.size * target.size * 4 > this._poolStashMaxBytes) continue;
            const allocStart = performance.now();
            const gl = this.context.gl;
            const fbo = this.context.createFramebuffer(target.size, target.size, true, true);
            const texture = new Texture(this.context, {width: target.size, height: target.size, data: null}, gl.RGBA, {poolTexture: true});
            texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            if (this.context.extTextureFilterAnisotropic) {
                gl.texParameterf(gl.TEXTURE_2D, this.context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, this.context.extTextureFilterAnisotropicMax);
            }
            fbo.colorAttachment.set(texture.texture);
            this._poolStash.push({size: target.size, fbo, texture});
            this._poolStashBytes += target.size * target.size * 4;
            const allocMs = performance.now() - allocStart;
            if (glStats.enabled && allocMs > 8) {
                console.log(`[map2-fork] slow pool alloc (warm): ${target.size}px ${allocMs.toFixed(1)}ms`);
            }
            return true;
        }
        return false;
    }

    /*
     * Reset some GL state to default values to avoid hard-to-debug bugs
     * in custom layers.
     */
    setCustomLayerDefaults() {
        // Prevent custom layers from unintentionally modify the last VAO used.
        // All other state is state is restored on it's own, but for VAOs it's
        // simpler to unbind so that we don't have to track the state of VAOs.
        this.context.unbindVAO();

        // The default values for this state is meaningful and often expected.
        // Leaving this state dirty could cause a lot of confusion for users.
        this.context.cullFace.setDefault();
        this.context.activeTexture.setDefault();
        this.context.pixelStoreUnpack.setDefault();
        this.context.pixelStoreUnpackPremultiplyAlpha.setDefault();
        this.context.pixelStoreUnpackFlipY.setDefault();
    }

    /*
     * Set GL state that is shared by all layers.
     */
    setBaseState() {
        const gl = this.context.gl;
        this.context.cullFace.set(false);
        this.context.viewport.set([0, 0, this.width, this.height]);
        this.context.blendEquation.set(gl.FUNC_ADD);
    }

    initDebugOverlayCanvas() {
        if (this.debugOverlayCanvas == null) {
            this.debugOverlayCanvas = document.createElement('canvas');
            this.debugOverlayCanvas.width = 512;
            this.debugOverlayCanvas.height = 512;
            const gl = this.context.gl;
            this.debugOverlayTexture = new Texture(this.context, this.debugOverlayCanvas, gl.RGBA);
        }
    }

    destroy() {
        for (const entry of this._poolStash) {
            entry.texture.destroy();
            entry.fbo.destroy();
        }
        this._poolStash = [];
        this._poolStashBytes = 0;
        if (this._tileTextures) {
            for (const size in this._tileTextures) {
                const textures = this._tileTextures[size];
                if (textures) {
                    for (const texture of textures) {
                        texture.destroy();
                    }
                }
            }
            this._tileTextures = {};
        }

        if (this.tileExtentBuffer) this.tileExtentBuffer.destroy();
        if (this.debugBuffer) this.debugBuffer.destroy();
        if (this.rasterBoundsBuffer) this.rasterBoundsBuffer.destroy();
        if (this.rasterBoundsBufferPosOnly) this.rasterBoundsBufferPosOnly.destroy();
        if (this.viewportBuffer) this.viewportBuffer.destroy();
        if (this.tileBorderIndexBuffer) this.tileBorderIndexBuffer.destroy();
        if (this.quadTriangleIndexBuffer) this.quadTriangleIndexBuffer.destroy();
        if (this.tileExtentMesh) this.tileExtentMesh.vertexBuffer?.destroy();
        if (this.tileExtentMesh) this.tileExtentMesh.indexBuffer?.destroy();

        if (this.debugOverlayTexture) {
            this.debugOverlayTexture.destroy();
        }

        if (this.cache) {
            for (const key in this.cache) {
                const program = this.cache[key];
                if (program?.program) {
                    this.context.gl.deleteProgram(program.program);
                }
            }
            this.cache = {};
        }

        if (this.context) {
            this.context.setDefault();
        }
    }

    /*
     * Return true if drawing buffer size is != from requested size.
     * That means that we've reached GL limits somehow.
     * Note: drawing buffer size changes only when canvas size changes
     */
    overLimit() {
        const {drawingBufferWidth, drawingBufferHeight} = this.context.gl;
        return this.width !== drawingBufferWidth || this.height !== drawingBufferHeight;
    }
}
