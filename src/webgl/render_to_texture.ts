import {type Painter, type RenderOptions} from '../render/painter';
import {type Tile} from '../tile/tile';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {type OverscaledTileID} from '../tile/tile_id';
import {drawTerrain} from './draw/draw_terrain';
import {type Style} from '../style/style';
import {type Terrain} from '../render/terrain';
import {RenderPool, type PoolObject} from './render_pool';
import {glStats} from './gl_stats';
import {type Texture} from './texture';
import type {StyleLayer} from '../style/style_layer';
import {ImageSource} from '../source/image_source';
import {warnOnce} from '../util/util';

/**
 * lookup table which layers should rendered to texture
 */
const LAYERS_TO_TEXTURES: { [keyof in StyleLayer['type']]?: boolean } = {
    background: true,
    fill: true,
    line: true,
    raster: true,
    hillshade: true,
    'color-relief': true
};

/**
 * Upper bound on the GPU memory the render pools may hold in stack textures. The pools
 * are sized to keep every (terrain tile × render stack) texture cached across frames;
 * this caps that growth for large tile counts / many stacks.
 */
const MAX_POOL_BYTES = 512 * 1024 * 1024;

/**
 * How many soft-invalidated (dirty) stack textures may re-render per frame. A batch of
 * arriving tiles can dirty 60+ (tile × stack) textures at once; re-rendering them all
 * in one frame costs several vsyncs of GPU time (observed 20–47ms) and drops presented
 * frames. Dirty entries keep drawing their stale texture — streaming already shows
 * coarse content briefly — and refresh a few per frame instead.
 */
const SOFT_RERENDERS_PER_FRAME = 6;

function getPoolBudgetBytes(): number {
    // navigator.deviceMemory is Chromium-only and reports at most 8 — treat 8 as
    // "desktop-class" and allow a larger texture budget there
    const deviceMemory = typeof navigator !== 'undefined' ? (navigator as any).deviceMemory : undefined;
    return deviceMemory >= 8 ? 1024 * 1024 * 1024 : MAX_POOL_BYTES;
}

/**
 * A style author can force a layer to start a new render-to-texture stack by setting
 * `"metadata": {"map2:rtt-stack-break": true}` on it. Use this to isolate layers whose
 * data changes every frame (e.g. an animated track) into their own small stack, so the
 * per-frame invalidation doesn't force the static layers below to re-render.
 */
function hasRttStackBreak(layer: StyleLayer): boolean {
    return !!(layer.metadata as {[_: string]: unknown})?.['map2:rtt-stack-break'];
}

/**
 * @internal
 * A helper class to help define what should be rendered to texture and how
 */
export class RenderToTexture {
    painter: Painter;
    terrain: Terrain;
    /**
     * texture pools by resolution tier: [0] full resolution (tileSize × qualityFactor)
     * for stacks with area content, [1] half resolution (tileSize) for line-only stacks
     * — draped line overlays read fine at half res and cost a quarter of the memory,
     * which is what bounds how many stack textures stay cached across frames.
     */
    pools: RenderPool[];
    /**
     * coordsAscending contains a list of all tiles which should be rendered for one render-to-texture tile
     * e.g. render 4 raster-tiles with size 256px to the 512px render-to-texture tile
     */
    _coordsAscending: {[_: string]: {[_:string]: OverscaledTileID[]}};
    /**
     * fingerprint string representing the unique state of source tiles and revision
     * for a given render-to-texture tile. Used to detect changes and trigger re-rendering.
     * Format: "sorted_tile_keys#revision"
     */
    _rttFingerprints: {[sourceId: string]: {[rttTileKey: string]: string}};
    /**
     * store for render-stacks
     * a render stack is a set of layers which should be rendered into one texture
     * every stylesheet can have multiple stacks. A new stack is created if layers which should
     * not rendered to texture sit between layers which should rendered to texture. e.g. hillshading or symbols
     */
    _stacks: string[][];
    /**
     * remember the previous processed layer to check if a new stack is needed
     */
    _prevType: string;
    /**
     * a list of tiles that can potentially rendered
     */
    _renderableTiles: Tile[];
    /**
     * a list of tiles that should be rendered to screen in the next render-call
     */
    _rttTiles: Tile[];
    /**
     * a list of all layer-ids which should be rendered
     */
    _renderableLayerIds: string[];
    /**
     * the stack layout of the previous frame, as a signature string. Cached textures are
     * addressed by stack index, so any change to the layout (style edit, zoom crossing a
     * layer's visibility threshold) makes every cached texture positionally stale.
     */
    _stacksSignature: string;
    /**
     * tile-content changes reported since the last frame (setData reloads, newly decoded
     * tiles). Processed in prepareForRender: each entry re-renders only the stacks that
     * drape the changed source, only on terrain tiles overlapping the changed tile.
     */
    _pendingSourceTileChanges: Array<{sourceId: string; tileID?: OverscaledTileID; soft?: boolean}>;
    /**
     * remaining dirty-entry re-renders this frame (see SOFT_RERENDERS_PER_FRAME)
     */
    _softRerenderBudget: number;
    constructor(painter: Painter, terrain: Terrain) {
        this.painter = painter;
        this.terrain = terrain;
        this.pools = [
            new RenderPool(painter.context, 30, terrain.tileManager.tileSize * terrain.qualityFactor),
            new RenderPool(painter.context, 30, terrain.tileManager.tileSize)
        ];
        this._pendingSourceTileChanges = [];
        this._softRerenderBudget = 0;
    }

    destruct() {
        for (const pool of this.pools) pool.destruct();
    }

    getTexture(tile: Tile): Texture {
        const entry = tile.rtt[this._stacks.length - 1];
        return this.pools[entry.pool].getObjectForId(entry.id).texture;
    }

    /**
     * Notification that a source tile's content changed (e.g. a GeoJSON setData reload or
     * a newly decoded tile). Queued and applied in the next prepareForRender, invalidating
     * only the render stacks that actually drape this source. Sources with no draped
     * layers (live symbols, circles) invalidate nothing.
     */
    markSourceTileChanged(sourceId: string, tileID: OverscaledTileID) {
        this._pendingSourceTileChanges.push({sourceId, tileID});
    }

    /**
     * Notification that a source's rendering changed everywhere without its data
     * changing (e.g. a per-frame uniform like the line progress clip). Invalidates the
     * stacks draping this source on all terrain tiles — the per-tile content skip
     * still limits actual re-rendering to tiles where the source has something to draw.
     */
    markSourceChanged(sourceId: string) {
        this._pendingSourceTileChanges.push({sourceId});
    }

    /**
     * Soft twin of markSourceChanged: the source's rendering changed everywhere (e.g. a
     * global-state input of a paint expression, like the 2D↔3D "3d-blend" fade), but the
     * stale texture is fine to keep drawing until the budgeted refresh reaches it. Entries
     * are marked dirty (re-rendered in place under SOFT_RERENDERS_PER_FRAME) instead of
     * dropped, so a per-frame fade re-renders the affected stacks round-robin without
     * burst-dropping frames. Style._applyGlobalStateChanges calls this automatically for
     * every source whose layers' paint reads a changed global-state property.
     */
    markSourceChangedSoft(sourceId: string) {
        this._pendingSourceTileChanges.push({sourceId, soft: true});
    }

    prepareForRender(style: Style, zoom: number) {
        for (const pool of this.pools) pool.beginFrame();
        this._stacks = [];
        this._prevType = null;
        this._rttTiles = [];
        this._renderableTiles = this.terrain.tileManager.getRenderableTiles();
        this._renderableLayerIds = style._order.filter(id => !style._layers[id].isHidden(zoom));

        this._coordsAscending = {};
        for (const id in style.tileManagers) {
            this._coordsAscending[id] = {};
            const tileIDs = style.tileManagers[id].getVisibleCoordinates();
            const source = style.tileManagers[id].getSource();
            const terrainTileRanges = source instanceof ImageSource ? source.terrainTileRanges : null;
            for (const tileID of tileIDs) {
                const keys = this.terrain.tileManager.getTerrainCoords(tileID, terrainTileRanges);
                for (const key in keys) {
                    this._coordsAscending[id][key] ||= [];
                    this._coordsAscending[id][key].push(keys[key]);
                }
            }

        }

        this._rttFingerprints = {};
        for (const id of style._order) {
            const layer = style._layers[id];
            const source = layer.source;
            const shouldRenderToTexture = LAYERS_TO_TEXTURES[layer.type];

            if (shouldRenderToTexture && !this._rttFingerprints[source]) {
                this._rttFingerprints[source] = {};
                const revision = style.tileManagers[source]?.getState().revision ?? 0;
                for (const key in this._coordsAscending[source])
                    this._rttFingerprints[source][key] = `${this._coordsAscending[source][key].map(c => c.key).sort().join()}#${revision}`;
            }
        }

        // The stack layout for this frame, derived exactly as renderLayer builds it below:
        // consecutive runs of render-to-texture layers, broken by live layers (e.g. symbols)
        // or an explicit metadata stack break. Needed to invalidate at stack granularity.
        const stacks: string[][] = [];
        let prevIsRtt = false;
        for (const id of this._renderableLayerIds) {
            const layer = style._layers[id];
            if (LAYERS_TO_TEXTURES[layer.type]) {
                if (!prevIsRtt || hasRttStackBreak(layer)) stacks.push([]);
                stacks[stacks.length - 1].push(id);
                prevIsRtt = true;
            } else if (layer.type !== 'fill-extrusion') {
                // fill-extrusions don't break the draped run (see renderLayer) — leave
                // prevIsRtt set so the drapes on both sides stay in one stack
                prevIsRtt = false;
            }
        }
        const sourceStackIndices: {[source: string]: number[]} = {};
        for (let index = 0; index < stacks.length; index++) {
            for (const id of stacks[index]) {
                const source = style._layers[id].source;
                if (!source) continue;
                sourceStackIndices[source] ||= [];
                if (!sourceStackIndices[source].includes(index)) sourceStackIndices[source].push(index);
            }
        }

        const signature = stacks.map(s => s.join(',')).join('|');
        if (signature !== this._stacksSignature) {
            this._stacksSignature = signature;
            this.terrain.tileManager.freeRtt();
            if (glStats.enabled) {
                // The stack audit's raw data, once per layout change (style edit,
                // zoom visibility flip, 2D↔3D): each stack is one composite pass
                // per terrain tile per frame plus one pool texture per tile.
                console.log(`[rtt] ${stacks.length} stack(s):\n${
                    stacks.map((s, i) => `  ${i} [tier ${this._stackTier(s, style)}] ${s.join(', ')}`).join('\n')}`);
            }
        }

        // apply queued tile-content changes at stack granularity. Tile-scoped changes
        // (streaming tile arrivals) are SOFT — the stale texture stays drawable and
        // refreshes under the per-frame budget, so an arrival batch can't burst-drop
        // frames. Source-wide changes (markSourceChanged: per-frame anim uniforms)
        // stay hard — the anim stack must repaint this frame or the grow head lags —
        // but only on tiles where the CHANGED SOURCE has content: the stack's other
        // sources may cover far more tiles (an accumulated reveal/done overlay spans
        // the whole map by the end of a run), and repainting those every frame made
        // the per-frame anim cost grow with run progress.
        for (const change of this._pendingSourceTileChanges) {
            const affectedStacks = sourceStackIndices[change.sourceId];
            if (!affectedStacks) continue;
            if (change.tileID) {
                this.terrain.tileManager.freeRtt(change.tileID, affectedStacks, true);
                continue;
            }
            for (const tile of this._renderableTiles) {
                if (!this._sourceHasContent(change.sourceId, tile)) continue;
                for (const index of affectedStacks) {
                    if (change.soft) {
                        // soft: keep drawing the stale texture, refresh under the budget
                        const entry = tile.rtt[index];
                        if (entry) entry.dirty = true;
                        else tile.rtt[index] = null;
                    } else {
                        tile.rtt[index] = null;
                    }
                }
            }
        }
        this._pendingSourceTileChanges = [];
        this._softRerenderBudget = SOFT_RERENDERS_PER_FRAME;

        // check tiles to render
        for (const tile of this._renderableTiles) {
            for (const source in this._rttFingerprints) {
                // rerender if there are different coords to render than in the last rendering
                // or if the source revision has changed — but only the stacks draping the
                // source, and softly: the stale texture keeps drawing until the budgeted
                // refresh reaches it (the fingerprint stays mismatched, so a deferred
                // entry is re-marked dirty every frame until it actually re-renders)
                const fingerprint = this._rttFingerprints[source][tile.tileID.key];
                if (fingerprint && fingerprint !== tile.rttFingerprint[source]) {
                    const affectedStacks = sourceStackIndices[source];
                    if (affectedStacks) {
                        for (const index of affectedStacks) {
                            const entry = tile.rtt[index];
                            if (entry) entry.dirty = true;
                            else tile.rtt[index] = null;
                        }
                    }
                }
            }
        }

        // Size the pools so a full frame's (tile × stack) textures can stay cached across
        // frames — recycling a free pool object evicts whatever cache entry it backs.
        // Capacity must never drop below the frame's demand: with capacity short of the
        // working set, every churn miss recycles an object a live entry used this frame,
        // that entry misses next frame and evicts another — the cascade saturates the
        // cache (measured on a 512MB-budget tablet at demand 90 / slots 60: every stack
        // re-rendering every frame, RTT draws 50–70% of all draw calls). Exceeding the
        // byte budget is strictly cheaper than thrashing under it, so the budget only
        // warns; when a device genuinely can't afford the working set, the levers are
        // demand-side (fewer stacks, lower qualityFactor), not a smaller pool.
        const tileSize = this.terrain.tileManager.tileSize;
        const bytesPerObject = [(tileSize * this.terrain.qualityFactor) ** 2 * 4, tileSize ** 2 * 4];
        const demand = [0, 0];
        for (const layerIds of stacks) {
            const tier = this._stackTier(layerIds, style);
            demand[tier] += this._renderableTiles.length;
        }
        const neededBytes = demand[0] * bytesPerObject[0] + demand[1] * bytesPerObject[1];
        const budgetBytes = style.map._rttPoolBudgetBytes || getPoolBudgetBytes();
        if (neededBytes > budgetBytes) {
            // Fixed message — warnOnce dedupes by exact text, so the fluctuating
            // working-set size must not be in it (glstats pool slots/demand has it).
            warnOnce(`[rtt] texture working set exceeds the pool budget (${Math.round(budgetBytes / (1024 * 1024))}MB); allocating it anyway — reduce stacks or quality to lower demand`);
        }
        for (let tier = 0; tier < this.pools.length; tier++) {
            this.pools[tier].setSize(Math.max(30, demand[tier]));
        }
        if (glStats.enabled) {
            glStats.frame.rttPoolSlots = this.pools[0].size + this.pools[1].size;
            glStats.frame.rttPoolDemand = demand[0] + demand[1];
        }
    }

    /**
     * due that switching textures is relatively slow, the render
     * layer-by-layer context is not practicable. To bypass this problem
     * this lines of code stack all layers and later render all at once.
     * Because of the stylesheet possibility to mixing render-to-texture layers
     * and 'live'-layers (f.e. symbols) it is necessary to create more stacks. For example
     * a symbol-layer is in between of fill-layers.
     * @param layer - the layer to render
     * @param renderOptions - flags describing how to render the layer
     * @returns if true layer is rendered to texture, otherwise false
     */
    renderLayer(layer: StyleLayer, renderOptions: RenderOptions): boolean {
        if (layer.isHidden(this.painter.transform.zoom)) return false;

        const options: RenderOptions = {...renderOptions, isRenderingToTexture: true};
        const type = layer.type;
        const isLastLayer = this._renderableLayerIds[this._renderableLayerIds.length - 1] === layer.id;

        // A fill-extrusion is live 3D geometry standing ABOVE the terrain surface. A draped
        // layer is that surface's texture, so it can never paint onto the extrusion — the
        // depth test keeps the building in front of any later drape composite — which makes
        // draped paint order AROUND an extrusion visually meaningless on terrain. So it need
        // not split the draped run into a separate stack: draw it live in place but leave
        // _prevType and the open stack untouched, and the drapes on both sides merge into ONE
        // stack + texture. This is mirrored in the stack-signature builder in prepareForRender
        // (the two must agree or stack invalidation desyncs from what actually rendered).
        // Exception: when it's the last renderable layer there's no following drape to merge
        // with and the pending stack still needs compositing, so fall through to the normal
        // path. NB the merged stack composites AFTER the building has drawn — correct for
        // opaque buildings (depth protects them, exactly as they already survive a later
        // stack's composite today); a translucent extrusion mid-zoom-fade would blend against
        // pre-stack content instead of the merged ground (accepted — opaque at follow-cam zoom).
        if (type === 'fill-extrusion' && !isLastLayer) {
            return false;
        }

        // remember background, fill, line & raster layer to render into a stack
        if (LAYERS_TO_TEXTURES[type]) {
            const prevWasRtt = this._prevType && LAYERS_TO_TEXTURES[this._prevType];
            // an explicit stack break sits between two texture layers, so the
            // accumulated stack must be rendered before a new one is started
            if (prevWasRtt && hasRttStackBreak(layer)) {
                this._renderStack(this._stacks.length - 1, options);
            }
            // create a new stack if previous layer was not rendered to texture (f.e. symbols)
            if (!prevWasRtt || hasRttStackBreak(layer)) this._stacks.push([]);
            // push current render-to-texture layer to render-stack
            this._prevType = type;
            this._stacks[this._stacks.length - 1].push(layer.id);
            // rendering is done later, all in once
            if (!isLastLayer) return true;
        }

        // in case a stack is finished render all collected stack-layers into a texture
        if (LAYERS_TO_TEXTURES[this._prevType] || (LAYERS_TO_TEXTURES[type] && isLastLayer)) {
            this._prevType = type;
            this._renderStack(this._stacks.length - 1, options);
            return LAYERS_TO_TEXTURES[type];
        }

        return false;
    }

    /**
     * render one collected stack into the renderable tiles' textures (cached in the
     * render pool where possible) and draw the result to screen via the terrain mesh
     */
    /**
     * the resolution tier a stack renders at. Tier 1 (half resolution for line-only
     * stacks) quarters the texture memory but softens the route overlays — opt-in via
     * Map.setLowResLineStacks (quality/memory tradeoff for constrained devices).
     * Cached entries record their tier, so toggling re-renders them automatically.
     */
    _stackTier(layerIds: string[], style: Style): number {
        if (!style.map._lowResLineStacks) return 0;
        return layerIds.length && layerIds.every(id => style._layers[id].type === 'line') ? 1 : 0;
    }

    _renderStack(stack: number, options: RenderOptions) {
        const painter = this.painter;
        const layers = this._stacks[stack] || [];
        const tier = this._stackTier(layers, painter.style);
        const pool = this.pools[tier];
        // A stack opened by an explicit break is DECLARED volatile — its sources
        // change per frame (animated tracks/reveals), and each per-frame setData
        // soft-dirties it across every tile the source reloads. Refreshing it must
        // not consume the soft budget: it's the cheap minimal stack, and letting it
        // monopolize the budget starves the basemap refreshes the budget exists for.
        const isVolatileStack = layers.length > 0 && hasRttStackBreak(painter.style._layers[layers[0]]);
        for (const tile of this._renderableTiles) {
            // a tile where no stack layer has anything to draw needs no texture, no
            // pool object and no composite draw (e.g. an animated track's stack only
            // touches the few tiles the track crosses)
            if (!this._stackHasContent(layers, tile)) {
                tile.rtt[stack] = null;
                continue;
            }
            // if render pool is full draw current tiles to screen and free pool
            if (pool.isFull()) {
                drawTerrain(this.painter, this.terrain, this._rttTiles, options);
                this._rttTiles = [];
                pool.freeAllObjects();
            }
            this._rttTiles.push(tile);
            // check for cached PoolObject
            let obj: PoolObject = null;
            let refreshInPlace = false;
            const cached = tile.rtt[stack];
            if (cached?.pool === tier) {
                const cachedObj = pool.getObjectForId(cached.id);
                if (cachedObj.stamp === cached.stamp) {
                    if (!cached.dirty) {
                        pool.useObject(cachedObj);
                        if (glStats.enabled) glStats.frame.rttTilesReused++;
                        continue;
                    }
                    if (!isVolatileStack && this._softRerenderBudget <= 0) {
                        // budget spent — draw the stale texture this frame; the entry
                        // stays dirty and refreshes in a later frame
                        pool.useObject(cachedObj);
                        if (glStats.enabled) glStats.frame.rttTilesDeferred++;
                        continue;
                    }
                    // refresh in place: same pool object, so no other entry is disturbed
                    if (!isVolatileStack) this._softRerenderBudget--;
                    obj = cachedObj;
                    refreshInPlace = true;
                }
            }
            if (!obj) obj = pool.getOrCreateFreeObject();
            pool.useObject(obj);
            pool.stampObject(obj);
            tile.rtt[stack] = {pool: tier, id: obj.id, stamp: obj.stamp};
            // prepare PoolObject for rendering
            if (glStats.enabled) {
                glStats.frame.rttTilesRendered++;
                if (refreshInPlace) glStats.frame.rttTilesRefreshed++;
                // a surviving cache entry whose pool object was recycled = eviction
                // (over-subscription); no entry at all = invalidation or first render
                else if (cached) glStats.frame.rttTilesEvicted++;
                else glStats.frame.rttTilesInvalidated++;
                glStats.inRtt = true;
            }
            painter.context.bindFramebuffer.set(obj.fbo.framebuffer);
            painter.context.clear({color: Color.transparent, stencil: 0});
            painter.currentStencilSource = undefined;
            for (const layerId of layers) {
                const layer = painter.style._layers[layerId];
                const coords = layer.source ? this._coordsAscending[layer.source][tile.tileID.key] : [tile.tileID];
                painter.context.viewport.set([0, 0, obj.fbo.width, obj.fbo.height]);
                // a single source tile at the terrain tile's zoom or above covers the whole
                // framebuffer — no overlap is possible and the tile buffer falls outside the
                // viewport, so the stencil clipping masks are pure overhead
                const noClipNeeded = coords?.length === 1 && coords[0].canonical.z <= tile.tileID.canonical.z;
                painter._renderTileClippingMasks(layer, coords, true, noClipNeeded);
                painter.renderLayer(painter, painter.style.tileManagers[layer.source], layer, coords, options);
                if (layer.source) tile.rttFingerprint[layer.source] = this._rttFingerprints[layer.source][tile.tileID.key];
            }
            glStats.inRtt = false;
        }
        drawTerrain(this.painter, this.terrain, this._rttTiles, options);
        this._rttTiles = [];
        pool.freeAllObjects();
        // the stencil refs (and any clipping-disabled state) stamped inside the pool
        // framebuffers don't exist in the buffer the next consumer draws into — force
        // the next tile-clipped layer to re-stamp
        painter.currentStencilSource = undefined;
        painter._clippingDisabled = false;
    }

    /**
     * whether any layer of a stack has content to draw on the given terrain tile
     */
    _stackHasContent(layerIds: string[], tile: Tile): boolean {
        const style = this.painter.style;
        for (const id of layerIds) {
            const layer = style._layers[id];
            // background layers draw everywhere
            if (!layer.source) return true;
            const coords = this._coordsAscending[layer.source]?.[tile.tileID.key];
            if (!coords?.length) continue;
            // raster / hillshade / color-relief draw from the source tile's texture
            // itself — they have content wherever a tile exists
            if (layer.type !== 'fill' && layer.type !== 'line') return true;
            // fill/line layers only draw where a covering tile holds a bucket for them
            const tileManager = style.tileManagers[layer.source];
            for (const coord of coords) {
                if (tileManager?.getTileByID(coord.key)?.getBucket(layer)) return true;
            }
        }
        return false;
    }

    /**
     * whether the given source has anything to draw on the given terrain tile —
     * the invalidation footprint of a source-wide change (markSourceChanged)
     */
    _sourceHasContent(sourceId: string, tile: Tile): boolean {
        const style = this.painter.style;
        const coords = this._coordsAscending[sourceId]?.[tile.tileID.key];
        if (!coords?.length) return false;
        const tileManager = style.tileManagers[sourceId];
        for (const id of this._renderableLayerIds) {
            const layer = style._layers[id];
            if (layer.source !== sourceId || !LAYERS_TO_TEXTURES[layer.type]) continue;
            // raster / hillshade / color-relief draw wherever a source tile exists
            if (layer.type !== 'fill' && layer.type !== 'line') return true;
            for (const coord of coords) {
                if (tileManager?.getTileByID(coord.key)?.getBucket(layer)) return true;
            }
        }
        return false;
    }

}
