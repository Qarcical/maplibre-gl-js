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
 * Grants are ALSO capped by count (grantCountCap): the measured upload time is
 * only the GL call issue time and undercounts a grant's true frame cost ~5× —
 * the RTT drape invalidation, symbol placement, and driver-deferred work it
 * triggers all land outside the measurement. Field capture 2026-07-16 (Surface,
 * flyTo arrival promoting a preloaded viewport): backlog 102 scaled the budget
 * to its 16ms cap and 98 tiles at ~0.17ms measured "fit" in one frame that
 * actually cost 88.7ms cpu — which demoted the governor, and the demotion
 * cooldown then held 30fps for ~11s. The count cap bounds the unmeasured side
 * effects; a 100-tile backlog drains over ~8 frames instead of 1.
 *
 * Exemptions (checked in TileManager._uploadGatedTiles):
 *  - volatile sources (any layer carrying map2:rtt-stack-break — the per-frame anim
 *    overlays) bypass the budget entirely: the grow head must never lag. Their time
 *    is still debited so basemap grants shrink around them.
 *  - reloads are never gated at all (Tile.gatedUpload is only set on fresh loads):
 *    loadVectorData already destroyed the old buckets, so deferring a reload would
 *    blank content that was on screen.
 *  - a tile with no renderable substitute (no ancestor or descendant covering it)
 *    is granted outside the budget — blank is worse than burst — but only up to
 *    exemptGrantCap tiles per frame. The cap exists because the exemption class
 *    is not always small: a preloaded viewport promoting all at once (flyTo
 *    arrival after preloadFlight) has NO renderable tile anywhere in its ladder,
 *    so without the cap every promoted tile granted in one frame — measured as
 *    the 145-upload / 65-grant flyTo-arrival frame that demoted the governor
 *    (2026-07-16 Surface A/B; the demotion cooldown then cost ~11s at 30fps).
 *    Coarse-first grant order sends the capped slots to the tiles that unlock
 *    the most coverage; each grant becomes the renderable substitute that lets
 *    the finer tiles behind it defer legitimately, so the region fills coarse-
 *    to-fine over a few frames instead of blank-to-everything in one.
 */
export class UploadScheduler {
    /** default on; Map#setUploadSpreading(false) restores upload-everything-on-arrival */
    enabled = true;
    /** sources any of whose layers carry map2:rtt-stack-break — their tiles bypass the budget */
    volatileSources = new Set<string>();
    /**
     * per-frame cap on no-substitute exemption grants (see the class doc);
     * <= 0 disables the cap (restores unbounded exemption grants).
     * Map#setUploadExemptGrantCap overrides.
     */
    exemptGrantCap = UploadScheduler.DEFAULT_EXEMPT_GRANT_CAP;
    /**
     * per-frame cap on grant COUNT regardless of remaining time budget (see the
     * class doc: measured upload time undercounts a grant's true frame cost, so
     * a backlog-scaled time budget alone still admits ~100-grant burst frames);
     * <= 0 disables the cap. Map#setUploadGrantCountCap overrides. Volatile
     * sources and the exemption path are not bound by it.
     */
    grantCountCap = UploadScheduler.DEFAULT_GRANT_COUNT_CAP;

    /** tiles granted this frame (glstats) */
    granted = 0;
    /** subset of granted: no-substitute exemption grants this frame (glstats) */
    exemptGranted = 0;
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
    /**
     * enough for the coarse skeleton of a viewport (one zoom ring is ~6–12 tiles
     * across all sources) without re-admitting the synchronized-promotion burst
     */
    static readonly DEFAULT_EXEMPT_GRANT_CAP = 6;
    /**
     * drains a 100-tile promotion backlog in ~8 frames (~140ms at 60fps) while
     * bounding each frame's unmeasured per-grant side effects (RTT invalidation,
     * placement) to ~2 frames of the RTT soft re-render budget
     */
    static readonly DEFAULT_GRANT_COUNT_CAP = 12;

    /**
     * called once per rendered frame, before Painter.render. isMoving suppresses
     * the backlog budget scale-up: the scale-up exists so time-to-full-detail
     * stays bounded AFTER arrival, but while the camera moves, detail latency is
     * invisible (coarse substitutes draw) and the scaled budget's 16ms upload
     * frames elevate the frame-cpu median right when a flyTo settles into a grow
     * — the governor demotes on that median (field capture 2026-07-16).
     */
    onFrameStart(framePeriodMs: number, isMoving: boolean = false) {
        if (framePeriodMs > 0) this._framePeriodMs = framePeriodMs;
        const backlog = this.deferred;
        this.granted = 0;
        this.exemptGranted = 0;
        this.deferred = 0;
        this.uploadMs = 0;

        const base = this._emaBaseCpuMs >= 0 ? this._emaBaseCpuMs : this._framePeriodMs * 0.5;
        const cap = Math.min(UploadScheduler.BUDGET_CAP_MS, this._framePeriodMs);
        let budget = (this._framePeriodMs - base) * 0.5;
        budget = Math.min(Math.max(budget, UploadScheduler.BUDGET_FLOOR_MS), cap);
        if (!isMoving && backlog > UploadScheduler.BACKLOG_SCALE_START) {
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

    /**
     * Whether a normal (non-volatile, non-exemption) grant may proceed: time
     * budget remaining AND grant count under grantCountCap. The count guard is
     * what actually bounds a synchronized-promotion backlog — cheap measured
     * uploads let ~100 tiles through a backlog-scaled time budget in one frame.
     */
    hasGrantCapacity(): boolean {
        if (!this.hasBudget()) {
            return false;
        }
        return this.grantCountCap <= 0 || this.granted < this.grantCountCap;
    }

    /**
     * Claim one of this frame's no-substitute exemption slots (see the class doc
     * on why the exemption class must be bounded). Returns false once the cap is
     * reached — the caller defers the tile; next frame the slots refresh and the
     * tiles granted this frame have become renderable substitutes for the rest.
     */
    tryExemptGrant(): boolean {
        if (this.exemptGrantCap > 0 && this.exemptGranted >= this.exemptGrantCap) {
            return false;
        }
        this.exemptGranted++;
        return true;
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
