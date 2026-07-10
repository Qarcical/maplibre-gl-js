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
    };
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
