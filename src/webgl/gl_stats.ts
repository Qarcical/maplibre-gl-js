/**
 * Per-frame GL call counters (see Map#setGlStats). Counting sits in the branches that
 * actually issue a GL call — after the value-dedup checks — so the numbers measure real
 * GL traffic, which is what the GPU process's command decoding cost is linear in.
 *
 * A module-level singleton rather than per-Context state so the hot call sites
 * (uniform_binding, value, program) don't need a context reference threaded through.
 * With more than one map on a page the counts would merge; acceptable for a
 * diagnostics tool.
 */

export type GlStatsFrame = {
    /** gl.drawElements calls (one per segment per Program.draw) */
    drawCalls: number;
    /** drawCalls issued while rendering stacks to texture (subset of drawCalls) */
    rttDrawCalls: number;
    /** Program.draw invocations (layer × tile × program granularity) */
    programDraws: number;
    /** individual gl.uniform* uploads that passed the value-dedup check */
    uniformCalls: number;
    /** gl.uniformMatrix4fv uploads (subset of uniformCalls) */
    matrixUploads: number;
    /** gl.useProgram calls that passed the dedup check */
    programSwitches: number;
    /** gl.bindTexture calls */
    textureBinds: number;
    /** (tile × stack) textures re-rendered this frame */
    rttTilesRendered: number;
    /**
     * re-renders whose cache entry still existed but whose pool object had been
     * recycled for another tile — pool over-subscription (subset of rttTilesRendered)
     */
    rttTilesEvicted: number;
    /**
     * re-renders with no cache entry at all — invalidation (fingerprint change,
     * freeRtt, source change) or a first render (subset of rttTilesRendered)
     */
    rttTilesInvalidated: number;
    /**
     * dirty entries re-rendered in place under the per-frame soft budget
     * (subset of rttTilesRendered)
     */
    rttTilesRefreshed: number;
    /** dirty entries that drew their stale texture because the soft budget was spent */
    rttTilesDeferred: number;
    /** (tile × stack) textures served from the render-pool cache this frame */
    rttTilesReused: number;
    /** render-pool capacity in objects, both tiers, after this frame's sizing */
    rttPoolSlots: number;
    /** render-pool demand in objects (renderable tiles × stacks, both tiers) */
    rttPoolDemand: number;
    /** terrain-mesh composite draws (tile × stack passes to screen) */
    terrainComposites: number;
    /** texImage2D/texSubImage2D calls carrying data (null-data allocations excluded) */
    texUploads: number;
    /** bytes uploaded by those texture calls (width × height × 4 for both RGBA8 and R32F) */
    texUploadBytes: number;
    /** bufferData/bufferSubData calls (vertex + index buffers) */
    bufferUploads: number;
    /** bytes uploaded by those buffer calls */
    bufferUploadBytes: number;
    /** RTT pool objects created this frame (framebuffer + 4–16MB texture each) */
    poolAllocs: number;
    /** ms spent creating them — the first terrain frame allocates the whole working set */
    poolAllocMs: number;
    /**
     * RTT pool objects released by shrink-to-demand this frame (stashed or destroyed) —
     * the demand-following counterpart of poolAllocs; the mem gauge shows the bytes
     */
    poolFrees: number;
    /** ms spent uploading DEM textures this frame (R32F, main-thread texImage2D) */
    demUploadMs: number;
    /** shader programs compiled+linked this frame (Painter.useProgram cache misses) */
    programCompiles: number;
    /**
     * ms spent in those compiles — the constructor's COMPILE/LINK_STATUS queries force
     * synchronous driver compilation, so this measures the real main-thread stall
     * (first-3D frames compile a batch of terrain/RTT variants at once)
     */
    programCompileMs: number;
    /** tiles whose gated first upload the scheduler granted this frame */
    tileUploadsGranted: number;
    /** subset of granted: no-substitute exemption grants (capped per frame) */
    tileUploadsExempt: number;
    /** gated tiles left waiting at frame end (drains at ~budget/emaTileMs per frame) */
    tileUploadsDeferred: number;
    /** ms the granted uploads actually took this frame */
    tileUploadMs: number;
    /** the scheduler's derived time budget for this frame (headroom-based, backlog-scaled) */
    tileUploadBudgetMs: number;
};

function zeroFrame(): GlStatsFrame {
    return {
        drawCalls: 0,
        rttDrawCalls: 0,
        programDraws: 0,
        uniformCalls: 0,
        matrixUploads: 0,
        programSwitches: 0,
        textureBinds: 0,
        rttTilesRendered: 0,
        rttTilesEvicted: 0,
        rttTilesInvalidated: 0,
        rttTilesRefreshed: 0,
        rttTilesDeferred: 0,
        rttTilesReused: 0,
        rttPoolSlots: 0,
        rttPoolDemand: 0,
        terrainComposites: 0,
        texUploads: 0,
        texUploadBytes: 0,
        bufferUploads: 0,
        bufferUploadBytes: 0,
        poolAllocs: 0,
        poolAllocMs: 0,
        poolFrees: 0,
        demUploadMs: 0,
        programCompiles: 0,
        programCompileMs: 0,
        tileUploadsGranted: 0,
        tileUploadsExempt: 0,
        tileUploadsDeferred: 0,
        tileUploadMs: 0,
        tileUploadBudgetMs: 0,
    };
}

/**
 * Resident GPU memory gauge — bytes currently ALLOCATED, not per-frame traffic.
 * Tracked unconditionally (alloc/free are rare next to draw calls, and enabling
 * glstats mid-session must still read correct residents). Covers every Texture
 * object (tile rasters, atlases, DEM, RTT pool render targets) and vertex/index
 * buffer. Not covered: renderbuffers (one shared depth-stencil per pool tier +
 * the terrain facilitator fbos — bounded, ~tens of MB), canvas backbuffers, and
 * browser-internal copies. Built for the iPhone crash hunt: iOS Safari jetsam-kills
 * a tab around ~1–1.5GB with no error, so the question is which category grows.
 */
export type GlMemGauge = {
    /** resident bytes across all live Texture objects */
    texBytes: number;
    texCount: number;
    /** subset of texBytes: R32F DEM textures */
    demBytes: number;
    /** subset of texBytes: RTT pool render targets (live pools + painter stash) */
    poolBytes: number;
    /** resident bytes across live vertex + index buffers (tile geometry) */
    bufferBytes: number;
    bufferCount: number;
};

export const glMem: GlMemGauge = {
    texBytes: 0,
    texCount: 0,
    demBytes: 0,
    poolBytes: 0,
    bufferBytes: 0,
    bufferCount: 0,
};

/**
 * PATCH (map2-fork): per-tag breakdown of `glMem.bufferBytes` — "WHICH layers hold the
 * vector geometry".
 *
 * The gauge above says the phone is holding ~440MB of decoded geometry when it dies; it
 * cannot say whether that is contours, scree, or elevation bands, and that is the only
 * thing that picks a lever. Tags are `<sourceID>/<layerId>`, applied by Tile#upload around
 * each bucket's own upload — the single funnel through which tile geometry reaches GL.
 *
 * Tracked UNCONDITIONALLY, for the same reason the gauge is: a buffer must be subtracted
 * from the tag it was added to, so tracking that starts when glstats is enabled mid-session
 * would drive live tags negative as pre-existing buffers are destroyed. Each buffer carries
 * its own tag for exactly this reason — a tag is never re-derived at destroy time.
 *
 * Anything created outside a bucket upload (terrain meshes, raster bounds, debug geometry)
 * lands in UNTAGGED, which is itself worth reading: if it is large, tile geometry is not
 * where the bytes are.
 */
export const UNTAGGED = '(untagged)';

export type GlMemTag = {bytes: number; count: number};

/** Bounded by the style's (source, layer) pair count — ~83 layers on trigpoints. */
export const glMemBufferTags: Map<string, GlMemTag> = new Map();

let currentBufferTag: string = UNTAGGED;

/** Set by Tile#upload around a bucket's upload; restored to UNTAGGED afterwards. */
export function setBufferMemTag(tag: string | null) {
    currentBufferTag = tag || UNTAGGED;
}

export function addTaggedBufferBytes(tag: string, bytes: number) {
    const entry = glMemBufferTags.get(tag);
    if (entry) {
        entry.bytes += bytes;
        entry.count++;
    } else {
        glMemBufferTags.set(tag, {bytes, count: 1});
    }
}

export function removeTaggedBufferBytes(tag: string, bytes: number) {
    const entry = glMemBufferTags.get(tag);
    if (!entry) return;
    entry.bytes -= bytes;
    entry.count--;
}

/** The tag a buffer being constructed right now belongs to. */
export function currentBufferMemTag(): string {
    return currentBufferTag;
}

/**
 * Live tags by resident bytes, biggest first. Empty tags are dropped from the report but
 * kept in the map — a layer that has just been released should read as gone, not linger.
 */
export function topBufferMemTags(limit: number): Array<{tag: string; bytes: number; count: number}> {
    const out: Array<{tag: string; bytes: number; count: number}> = [];
    glMemBufferTags.forEach((entry, tag) => {
        if (entry.bytes > 0) out.push({tag, bytes: entry.bytes, count: entry.count});
    });
    out.sort((a, b) => b.bytes - a.bytes);
    return out.slice(0, limit);
}

class GlStats {
    /** counting is skipped entirely when disabled — the call sites are render-loop hot */
    enabled: boolean = false;
    /** true while RenderToTexture._renderStack is drawing into a pool framebuffer */
    inRtt: boolean = false;
    frame: GlStatsFrame = zeroFrame();

    beginFrame() {
        this.frame = zeroFrame();
        this.inRtt = false;
    }

    endFrame(): GlStatsFrame {
        return this.frame;
    }
}

export const glStats = new GlStats();

/**
 * Per-counter median and max across a window of frames. Median is the KPI —
 * tile-arrival bursts inflate individual frames independently of the steady-state
 * cost (same reasoning as the frame governor's median).
 */
export function summarizeGlStats(frames: GlStatsFrame[]): {median: GlStatsFrame; max: GlStatsFrame} {
    const median = zeroFrame();
    const max = zeroFrame();
    if (!frames.length) return {median, max};
    const scratch = new Array(frames.length);
    for (const key of Object.keys(median) as Array<keyof GlStatsFrame>) {
        for (let i = 0; i < frames.length; i++) {
            scratch[i] = frames[i][key];
            if (frames[i][key] > max[key]) max[key] = frames[i][key];
        }
        scratch.sort((a, b) => a - b);
        median[key] = scratch[scratch.length >> 1];
    }
    return {median, max};
}
