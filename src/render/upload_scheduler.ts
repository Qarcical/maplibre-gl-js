/**
 * map2 fork: spread tile GPU uploads across frames (see Map#setUploadSpreading).
 *
 * A tile's buckets upload on the first TileManager.prepare() after their worker data
 * lands, so a tile batch (initial load, 3D entry promoting a preloaded viewport, a
 * flyTo crossing fresh terrain) used to run every new tile's bufferData/texImage
 * calls inside one frame — measured as ~200-call burst frames and a 320–370ms
 * single-frame load stall. The scheduler bounds the per-frame upload work with a
 * TIME budget: gated tiles are granted in priority order until the budget is spent;
 * a denied tile stays non-renderable (Tile.gatedUpload), so the retention machinery
 * keeps drawing the covering parent/child exactly as if the tile were still loading
 * — briefly coarser, never blank.
 *
 * The budget is derived, not fixed, so it scales with the machine (a fixed call
 * count would be sub-millisecond work on a fast desktop and near a whole frame on a
 * slow tablet):
 *
 *   budget = clamp((framePeriod − emaBaseFrameCpu) / 2, floor .. min(cap, framePeriod))
 *
 * The frame period comes from the governor's cap (or the vsync estimate when
 * uncapped) and the base frame cost is an EMA of the render loop's own cpu
 * measurement minus the time this scheduler itself spent — so sustained uploading
 * can't eat its own headroom. Because the budget scales with the period, a governor
 * demotion (fewer frames) grants more per frame and the drain rate per SECOND stays
 * constant. A deep backlog (big flyTo) scales the budget up so time-to-full-detail
 * stays bounded.
 *
 * Grants are per-tile and greedy — upload, measure, subtract, stop once spent —
 * because a tile's buckets must upload atomically (a partial tile would draw with
 * layers missing). Worst-case overshoot is therefore one tile, and the measured
 * per-tile EMA is reported for diagnostics rather than used to predict.
 *
 * Exemptions (checked in TileManager._uploadGatedTiles):
 *  - volatile sources (any layer carrying map2:rtt-stack-break — the per-frame anim
 *    overlays) bypass the budget entirely: the grow head must never lag. Their time
 *    is still debited so basemap grants shrink around them.
 *  - reloads are never gated at all (Tile.gatedUpload is only set on fresh loads):
 *    loadVectorData already destroyed the old buckets, so deferring a reload would
 *    blank content that was on screen.
 *  - a tile with no renderable substitute (no ancestor or descendant covering it)
 *    is granted unconditionally — blank is worse than burst. This bounds the
 *    exemption to first paint of a region: granting the coarse skeleton makes it
 *    the substitute that lets every finer tile be deferred.
 */
export class UploadScheduler {
    /** default on; Map#setUploadSpreading(false) restores upload-everything-on-arrival */
    enabled = true;
    /** sources any of whose layers carry map2:rtt-stack-break — their tiles bypass the budget */
    volatileSources = new Set<string>();

    /** tiles granted this frame (glstats) */
    granted = 0;
    /** gated tiles left waiting this frame (glstats; >0 keeps the repaint loop alive) */
    deferred = 0;
    /** ms spent uploading this frame (glstats) */
    uploadMs = 0;

    private _framePeriodMs = 1000 / 60;
    /** EMA of the frame's non-upload main-thread cost; <0 = no sample yet */
    private _emaBaseCpuMs = -1;
    /** EMA of a single tile's measured upload cost (diagnostics/drain estimates) */
    private _emaTileUploadMs = 0.5;
    private _budgetMs = 0;
    private _spentMs = 0;
    /** upload time spent outside the gated path (DEM textures) — debits the next frame */
    private _carryoverMs = 0;

    private static readonly BUDGET_FLOOR_MS = 1.0;
    private static readonly BUDGET_CAP_MS = 16.0;
    /** backlogs beyond this many tiles scale the budget up so big flyTo bursts drain fast */
    private static readonly BACKLOG_SCALE_START = 16;

    /** called once per rendered frame, before Painter.render */
    onFrameStart(framePeriodMs: number) {
        if (framePeriodMs > 0) this._framePeriodMs = framePeriodMs;
        const backlog = this.deferred;
        this.granted = 0;
        this.deferred = 0;
        this.uploadMs = 0;

        const base = this._emaBaseCpuMs >= 0 ? this._emaBaseCpuMs : this._framePeriodMs * 0.5;
        const cap = Math.min(UploadScheduler.BUDGET_CAP_MS, this._framePeriodMs);
        let budget = (this._framePeriodMs - base) * 0.5;
        budget = Math.min(Math.max(budget, UploadScheduler.BUDGET_FLOOR_MS), cap);
        if (backlog > UploadScheduler.BACKLOG_SCALE_START) {
            budget = Math.min(budget * (backlog / UploadScheduler.BACKLOG_SCALE_START), cap);
        }
        this._budgetMs = budget;
        this._spentMs = this._carryoverMs;
        this._carryoverMs = 0;
    }

    /** called with the frame's measured main-thread cost, after Painter.render */
    onFrameEnd(frameCpuMs: number) {
        // subtract this frame's grant time so the EMA tracks the BASE frame cost
        const base = Math.max(0, frameCpuMs - this.uploadMs);
        this._emaBaseCpuMs = this._emaBaseCpuMs < 0 ? base : this._emaBaseCpuMs * 0.9 + base * 0.1;
    }

    hasBudget(): boolean {
        return this._spentMs < this._budgetMs;
    }

    noteGranted(ms: number) {
        this.granted++;
        this.uploadMs += ms;
        this._spentMs += ms;
        this._emaTileUploadMs = this._emaTileUploadMs * 0.8 + ms * 0.2;
    }

    noteDeferred() {
        this.deferred++;
    }

    /**
     * Upload work that runs outside the gated path but spends the same main-thread
     * time (terrain DEM texture creation) — debit it against the NEXT frame's budget
     * (it lands after this frame's grants have already run).
     */
    noteExternalUpload(ms: number) {
        this._carryoverMs += ms;
    }

    get budgetMs(): number {
        return this._budgetMs;
    }

    get emaTileUploadMs(): number {
        return this._emaTileUploadMs;
    }

    /** gated tiles still waiting after this frame's grants */
    get pendingCount(): number {
        return this.deferred;
    }

    /** rebuild the volatile-source set from the style's current layer list (cheap; per frame) */
    updateVolatileSources(style: {_order: string[]; _layers: {[_: string]: {source?: string; metadata?: unknown}}}) {
        this.volatileSources.clear();
        for (const id of style._order) {
            const layer = style._layers[id];
            if (layer?.source && (layer.metadata as {[_: string]: unknown})?.['map2:rtt-stack-break']) {
                this.volatileSources.add(layer.source);
            }
        }
    }
}
